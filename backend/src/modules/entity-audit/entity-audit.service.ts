/**
 * Entity Audit Service — Schema checker + entity CRUD + platform records.
 *
 * Checks how the client entity is described in structured data (JSON-LD schema)
 * and on third-party platforms (manual entry + optional semi-auto fetch). Detects
 * inconsistencies that cause AI assistants to mischaracterize or fail to recognize
 * the entity.
 *
 * Model-diff (asking AI models "what is X?") is deferred — see LEFT-OUT.md.
 *
 * Ownership: every entity is scoped to a project via EntityAudit.projectId.
 * All methods verify projectId ↔ entityId ownership before mutating or returning
 * sensitive data; cross-project access returns 404.
 *
 * @module entity-audit.service
 */

import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { FetcherService } from '../fetcher/fetcher.service';
import { PrismaService } from '../database/prisma.service';
import { AnthropicSurfaceAdapter } from '../measurement/adapters/anthropic.adapter';
import { PerplexitySurfaceAdapter } from '../measurement/adapters/perplexity.adapter';
import type { SurfaceAnswer, Surface } from '../measurement/measurement.types';
import type {
  SchemaCheckResult,
  SameAsVerificationResult,
} from './entity-audit.types';

@Injectable()
export class EntityAuditService {
  private readonly logger = new Logger(EntityAuditService.name);
  private anthropic: Anthropic | null = null;

  constructor(
    private readonly fetcher: FetcherService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly anthropicSurface: AnthropicSurfaceAdapter,
    private readonly perplexitySurface: PerplexitySurfaceAdapter,
  ) {}

  // ─── Helpers ───────────────────────────────────────────────────

  /**
   * Verify that an entity belongs to the given project. Throws 404 if not.
   * Returns the entity with its audit container for convenience.
   */
  private async assertOwnership(projectId: string, entityId: string) {
    const entity = await this.prisma.entity.findUnique({
      where: { id: entityId },
      include: { entityAudit: true },
    });
    if (!entity || entity.entityAudit.projectId !== projectId) {
      throw new NotFoundException(`Entity ${entityId} not found in project ${projectId}`);
    }
    return entity;
  }

  /**
   * Resolve EntityAudit container for a project — create if missing.
   */
  private async getOrCreateAudit(projectId: string) {
    let entityAudit = await this.prisma.entityAudit.findFirst({ where: { projectId } });
    if (!entityAudit) {
      entityAudit = await this.prisma.entityAudit.create({ data: { projectId } });
    }
    return entityAudit;
  }

  // ─── Entity CRUD ──────────────────────────────────────────────

  /**
   * Create a new entity for a project.
   */
  async createEntity(projectId: string, name: string, type: string, descriptor?: string) {
    const entityAudit = await this.getOrCreateAudit(projectId);

    const entity = await this.prisma.entity.create({
      data: {
        entityAuditId: entityAudit.id,
        name: name.trim(),
        type,
        descriptor: descriptor?.trim() || null,
      },
    });

    this.logger.log(`Created entity: ${entity.name} (${entity.id}) for project ${projectId}`);
    return entity;
  }

  /**
   * Update an entity (name/descriptor/type). Only fields provided are updated.
   */
  async updateEntity(projectId: string, entityId: string, patch: { name?: string; descriptor?: string; type?: string }) {
    await this.assertOwnership(projectId, entityId);

    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data['name'] = patch.name.trim();
    if (patch.descriptor !== undefined) data['descriptor'] = patch.descriptor?.trim() || null;
    if (patch.type !== undefined) data['type'] = patch.type;

    const updated = await this.prisma.entity.update({
      where: { id: entityId },
      data,
    });
    this.logger.log(`Updated entity ${entityId} in project ${projectId}`);
    return updated;
  }

  /**
   * Delete an entity and its dependent records (cascade via FK).
   */
  async deleteEntity(projectId: string, entityId: string) {
    await this.assertOwnership(projectId, entityId);
    await this.prisma.entity.delete({ where: { id: entityId } });
    this.logger.log(`Deleted entity ${entityId} from project ${projectId}`);
    return { deleted: true, entityId };
  }

  /**
   * List all entities for a project with their schema checks and platform records.
   */
  async listEntities(projectId: string) {
    const entityAudit = await this.prisma.entityAudit.findFirst({
      where: { projectId },
      include: {
        entities: {
          orderBy: { createdAt: 'asc' },
          include: {
            schemaChecks: { orderBy: { checkedAt: 'desc' } },
            platformRecords: true,
            modelDiffs: { orderBy: { createdAt: 'desc' } },
          },
        },
      },
    });

    if (!entityAudit) {
      return { entities: [] };
    }

    return { entities: entityAudit.entities };
  }

  /**
   * Get a specific entity with all its data. Verifies project ownership.
   */
  async getEntity(projectId: string, entityId: string) {
    await this.assertOwnership(projectId, entityId);
    const entity = await this.prisma.entity.findFirst({
      where: { id: entityId },
      include: {
        schemaChecks: { orderBy: { checkedAt: 'desc' } },
        platformRecords: true,
        modelDiffs: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!entity) {
      throw new NotFoundException(`Entity ${entityId} not found`);
    }

    return entity;
  }

  /**
   * Schema-check history for an entity (paginated, newest first).
   */
  async getSchemaChecks(projectId: string, entityId: string, limit = 20) {
    await this.assertOwnership(projectId, entityId);
    const checks = await this.prisma.schemaCheck.findMany({
      where: { entityId },
      orderBy: { checkedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 50),
    });
    return { entityId, checks, count: checks.length };
  }

  // ─── Schema Check (FR-3.2) ─────────────────────────────────────

  /**
   * Run a schema check on a URL — extract JSON-LD, validate fields,
   * and verify each sameAs link resolves and matches the entity identity.
   * Handles @graph, multiple blocks, and string vs array sameAs.
   */
  async runSchemaCheck(projectId: string, entityId: string, url: string): Promise<SchemaCheckResult> {
    await this.assertOwnership(projectId, entityId);
    this.logger.debug(`Running schema check for ${url} (entity: ${entityId})`);

    const runId = `schema_${Date.now()}`;

    // Fetch the page and extract schema
    const schemaResult = await this.fetcher.fetchSchema(url, 'entity-audit', runId);
    // fetcher.extractJsonLd handles @graph internally-ish; also flatten @graph manually for robustness
    const schemas = this.flattenSchemas(schemaResult.schemas);

    // Find Organization, Person, or LocalBusiness schema
    const orgSchema = schemas.find(
      (s) => s.type.includes('Organization') || s.type.includes('LocalBusiness') || s.type.includes('Person'),
    );

    const schemaType = orgSchema?.type || (schemas.length > 0 ? schemas[0].type : null);
    const fieldsPresent = orgSchema ? Object.keys(orgSchema.fields).filter((k) => orgSchema.fields[k] != null && orgSchema.fields[k] !== '') : [];
    const fieldsMissing: string[] = [];

    // Check for recommended fields based on schema type
    const recommendedFields = ['name', 'url', 'description', 'logo', 'sameAs'];
    if (orgSchema) {
      for (const field of recommendedFields) {
        if (orgSchema.fields[field] == null || orgSchema.fields[field] === '') fieldsMissing.push(field);
      }
    }

    // Extract sameAs URLs — handle nested and string forms
    const sameAsUrls: string[] = this.extractSameAs(orgSchema);

    // Get entity name for identity matching
    const entity = await this.prisma.entity.findUnique({ where: { id: entityId } });
    const expectedName = entity?.name || (orgSchema?.fields['name'] as string) || '';

    // Verify each sameAs URL (limited to 10 for cost control)
    const sameAsVerification: SameAsVerificationResult[] = [];
    const urlsToCheck = sameAsUrls.slice(0, 10);

    for (const sameAsUrl of urlsToCheck) {
      try {
        const verification = await this.fetcher.verifyUrl(
          { url: sameAsUrl, expectedName },
          'entity-audit',
          runId,
        );

        sameAsVerification.push({
          url: sameAsUrl,
          resolves: verification.resolves,
          identityMatch: verification.identityMatch ?? null,
          title: verification.title ?? null,
          statusCode: verification.statusCode ?? null,
        });
      } catch {
        sameAsVerification.push({
          url: sameAsUrl,
          resolves: false,
          identityMatch: null,
          title: null,
          statusCode: null,
        });
      }
    }

    // Determine status
    const hasSchema = schemas.length > 0;
    const hasBrokenSameAs = sameAsVerification.some((v) => !v.resolves);
    const hasIdentityMismatch = sameAsVerification.some((v) => v.resolves && v.identityMatch === false);
    const status: 'pass' | 'fail' | 'error' =
      !hasSchema ? 'fail' : hasBrokenSameAs || hasIdentityMismatch ? 'fail' : 'pass';

    // Build recommended fix
    let recommendedFix = '';
    if (!hasSchema) {
      recommendedFix = 'No JSON-LD structured data found. Add Organization or Person schema with name, url, description, logo, and sameAs links.';
    } else if (fieldsMissing.length > 0) {
      recommendedFix = `Schema found but missing recommended fields: ${fieldsMissing.join(', ')}. Add these to improve entity recognition by AI assistants.`;
    } else if (hasBrokenSameAs) {
      const broken = sameAsVerification.filter((v) => !v.resolves).map((v) => v.url);
      recommendedFix = `Broken sameAs links detected: ${broken.join(', ')}. These links don't resolve — update or remove them from your schema.`;
    } else if (hasIdentityMismatch) {
      const mismatched = sameAsVerification.filter((v) => v.resolves && v.identityMatch === false).map((v) => v.url);
      recommendedFix = `sameAs identity mismatch at: ${mismatched.join(', ')}. The linked page's title doesn't match the entity name — verify these are correct references.`;
    } else {
      recommendedFix = `Schema looks complete: ${schemaType}, ${fieldsPresent.length} fields, ${sameAsUrls.length} sameAs links (all verified).`;
    }

    const result: SchemaCheckResult = {
      entityId,
      schemaType,
      fieldsPresent,
      fieldsMissing,
      sameAsCount: sameAsUrls.length,
      sameAsUrls,
      sameAsVerification,
      status,
      checkedAt: new Date().toISOString(),
      recommendedFix,
    };

    // Persist to database
    try {
      await this.prisma.schemaCheck.create({
        data: {
          entityId,
          schemaType,
          fieldsPresent: JSON.stringify(fieldsPresent),
          fieldsMissing: JSON.stringify(fieldsMissing),
          sameAsCount: sameAsUrls.length,
          sameAsUrls: JSON.stringify(sameAsUrls),
          sameAsVerification: JSON.stringify(sameAsVerification),
          status,
        },
      });
      this.logger.debug(`Schema check persisted for entity ${entityId}`);
    } catch (err) {
      this.logger.warn(`Failed to persist schema check: ${(err as Error).message}`);
    }

    return result;
  }

  private flattenSchemas(schemas: Array<{ type: string; fields: Record<string, unknown> }>) {
    const flat: Array<{ type: string; fields: Record<string, unknown> }> = [];
    for (const s of schemas) {
      // fetcher.parseSchemaBlock already handles @graph at top level, but handle nested @graph fields
      const graph = (s.fields as any)['@graph'];
      if (Array.isArray(graph)) {
        for (const node of graph) {
          const t = node['@type'] || 'Unknown';
          const { '@type': _t, '@context': _c, '@graph': _g, ...rest } = node;
          flat.push({ type: Array.isArray(t) ? t.join(',') : String(t), fields: rest as Record<string, unknown> });
        }
        // also keep the parent if it has other fields
        const { '@graph': _g2, ...restParent } = s.fields as any;
        if (Object.keys(restParent).length > 0) flat.push({ type: s.type, fields: restParent });
      } else {
        flat.push(s);
      }
    }
    return flat;
  }

  private extractSameAs(orgSchema: { fields: Record<string, unknown> } | undefined): string[] {
    if (!orgSchema) return [];
    const sameAs = orgSchema.fields['sameAs'];
    const urls: string[] = [];
    if (Array.isArray(sameAs)) {
      urls.push(...sameAs.filter((u): u is string => typeof u === 'string' && u.startsWith('http')));
    } else if (typeof sameAs === 'string' && sameAs.startsWith('http')) {
      urls.push(sameAs);
    }
    // also check inside @graph-derived nodes where sameAs might be under different casing
    return [...new Set(urls)];
  }

  // ─── Platform Record ──────────────────────────────────────────

  /**
   * Create a platform record (manual entry by delivery lead).
   * If verifySource is true and sourceUrl is set, does a single-page fetch (semi-auto, low ToS risk)
   * to capture the fetched title and auto-infer consistencyStatus.
   */
  async createPlatformRecord(
    projectId: string,
    entityId: string,
    platform: string,
    recordedName?: string,
    recordedDescriptor?: string,
    sourceUrl?: string,
    consistencyStatus: string = 'not-checked',
    verifySource = false,
  ) {
    await this.assertOwnership(projectId, entityId);

    // Semi-auto verification: fetch sourceUrl once and infer consistency
    let fetchedTitle: string | null = null;
    let inferredStatus = consistencyStatus;
    if (verifySource && sourceUrl) {
      try {
        const runId = `platform_${Date.now()}`;
        const verification = await this.fetcher.verifyUrl(
          { url: sourceUrl, expectedName: recordedName || (await this.prisma.entity.findUnique({ where: { id: entityId } }))?.name || '' },
          'entity-audit',
          runId,
        );
        fetchedTitle = verification.title || null;
        if (verification.resolves) {
          inferredStatus = verification.identityMatch ? 'match' : 'mismatch';
        }
      } catch {
        // fetch failed — keep not-checked
      }
    }

    const record = await this.prisma.platformRecord.create({
      data: {
        entityId,
        platform,
        recordedName: recordedName?.trim() || null,
        recordedDescriptor: recordedDescriptor?.trim() || null,
        sourceUrl: sourceUrl || null,
        consistencyStatus: inferredStatus,
      },
    });

    this.logger.log(`Created platform record: ${platform} for entity ${entityId} (verify=${verifySource ? 'yes' : 'no'})`);
    return { ...record, ...(fetchedTitle ? { fetchedTitle } : {}) };
  }

  async updatePlatformRecord(
    projectId: string,
    entityId: string,
    recordId: string,
    patch: { platform?: string; recordedName?: string; recordedDescriptor?: string; sourceUrl?: string; consistencyStatus?: string },
  ) {
    await this.assertOwnership(projectId, entityId);
    const existing = await this.prisma.platformRecord.findFirst({ where: { id: recordId, entityId } });
    if (!existing) throw new NotFoundException(`Platform record ${recordId} not found for entity ${entityId}`);

    const data: Record<string, unknown> = {};
    if (patch.platform !== undefined) data['platform'] = patch.platform;
    if (patch.recordedName !== undefined) data['recordedName'] = patch.recordedName?.trim() || null;
    if (patch.recordedDescriptor !== undefined) data['recordedDescriptor'] = patch.recordedDescriptor?.trim() || null;
    if (patch.sourceUrl !== undefined) data['sourceUrl'] = patch.sourceUrl || null;
    if (patch.consistencyStatus !== undefined) data['consistencyStatus'] = patch.consistencyStatus;

    const updated = await this.prisma.platformRecord.update({ where: { id: recordId }, data });
    return updated;
  }

  async deletePlatformRecord(projectId: string, entityId: string, recordId: string) {
    await this.assertOwnership(projectId, entityId);
    const existing = await this.prisma.platformRecord.findFirst({ where: { id: recordId, entityId } });
    if (!existing) throw new NotFoundException(`Platform record ${recordId} not found for entity ${entityId}`);
    await this.prisma.platformRecord.delete({ where: { id: recordId } });
    return { deleted: true, recordId };
  }

  /**
   * Check platform consistency — compare recorded name/descriptor with entity name.
   * Verifies ownership and returns per-record match/mismatch.
   */
  async checkPlatformConsistency(projectId: string, entityId: string) {
    const entity = await this.prisma.entity.findFirst({
      where: { id: entityId },
      include: { entityAudit: true, platformRecords: true },
    });

    if (!entity || entity.entityAudit.projectId !== projectId) {
      throw new NotFoundException(`Entity ${entityId} not found in project ${projectId}`);
    }

    const results = entity.platformRecords.map((record) => {
      const nameMatches = record.recordedName
        ? record.recordedName.toLowerCase().trim() === entity.name.toLowerCase().trim()
        : record.consistencyStatus === 'match';
      // If a record has explicit mismatch/match stored, respect mismatch; else compute from name
      const consistencyStatus =
        record.consistencyStatus === 'mismatch' ? ('mismatch' as const)
        : record.consistencyStatus === 'match' ? ('match' as const)
        : nameMatches ? ('match' as const) : record.recordedName ? ('mismatch' as const) : ('not-checked' as const);
      return {
        platform: record.platform,
        recordedName: record.recordedName,
        entityName: entity.name,
        consistencyStatus,
        sourceUrl: record.sourceUrl,
      };
    });

    return { entityId, checks: results };
  }

  // ─── Model-Diff (deferred but queryable) ───────────────────────

  async listModelDiffs(projectId: string, entityId: string) {
    await this.assertOwnership(projectId, entityId);
    const diffs = await this.prisma.modelDiff.findMany({
      where: { entityId },
      orderBy: { createdAt: 'desc' },
    });
    return { entityId, diffs, count: diffs.length };
  }

  // ─── Model-Diff (FR-4.x, "ask the models") ─────────────────────

  /**
   * Run the model-diff: send the identity prompt ("What is {entity}?") to every
   * keyed surface (Claude and Perplexity per the approved v1 surface analysis),
   * store raw answers + citations, then run the Claude-blind-judge comparison
   * to surface descriptor divergence across models.
   * @throws ServiceUnavailableException when no surface API key is configured.
   */
  async runModelDiff(projectId: string, entityId: string, prompt?: string) {
    const entity = await this.assertOwnership(projectId, entityId);

    const surfaces: Array<{ provider: string; run: (p: string) => Promise<SurfaceAnswer> }> = [];
    if (this.config.get<string>('ANTHROPIC_API_KEY')) {
      surfaces.push({ provider: 'claude', run: (p) => this.anthropicSurface.runPrompt(p, 'US') });
    }
    if (this.config.get<string>('PERPLEXITY_API_KEY')) {
      surfaces.push({ provider: 'perplexity', run: (p) => this.perplexitySurface.runPrompt(p, 'US') });
    }
    if (surfaces.length === 0) {
      throw new ServiceUnavailableException(
        'No surface API keys configured — set ANTHROPIC_API_KEY and/or PERPLEXITY_API_KEY (see LEFT-OUT.md section 1)',
      );
    }

    const identityPrompt = prompt ?? 'What is ' + entity.name + '? One short paragraph.';
    const run = await this.prisma.modelDiff.create({
      data: { entityId, prompt: identityPrompt, provider: 'multi', status: 'running' },
    });

    const answers: Array<{ provider: string; text: string }> = [];
    for (const surface of surfaces) {
      try {
        const answer = await surface.run(identityPrompt);
        await this.prisma.modelDiff.create({
          data: {
            entityId,
            prompt: identityPrompt,
            provider: surface.provider,
            model: answer.model ?? null,
            rawAnswer: answer.text,
            citations: JSON.stringify(answer.citations ?? []),
            status: 'completed',
            costUsd: answer.costUsd ?? 0,
            latencyMs: answer.latencyMs ?? 0,
          },
        });
        answers.push({ provider: surface.provider, text: answer.text });
      } catch (err) {
        await this.prisma.modelDiff.create({
          data: {
            entityId,
            prompt: identityPrompt,
            provider: surface.provider,
            rawAnswer: null,
            status: 'failed',
          },
        });
        this.logger.error('Model-diff failed on ' + surface.provider + ': ' + (err as Error).message);
      }
    }

    // Judge pass: Claude compares descriptor divergence across stored answers.
    const divergence = await this.judgeDivergence(entity.name as string, answers);

    const updated = await this.prisma.modelDiff.update({
      where: { id: run.id },
      data: {
        status: answers.length > 0 ? 'completed' : 'failed',
        divergence,
        checkedAt: new Date(),
        rawAnswer: JSON.stringify(answers.map((a) => ({ provider: a.provider, answer: a.text }))),
      },
    });

    return { runId: updated.id, status: updated.status, divergence, answers: answers.length };
  }

  /** LLM judge: short divergence report across providers; null when <2 answers. */
  private async judgeDivergence(entityName: string, answers: Array<{ provider: string; text: string }>): Promise<string | null> {
    if (answers.length < 2) {
      return null;
    }
    const configured = this.config.get<string>('ANTHROPIC_API_KEY');
    if (!configured) {
      return 'judge-unavailable: divergence scoring needs ANTHROPIC_API_KEY';
    }
    try {
      if (!this.anthropic) {
        this.anthropic = new Anthropic({ apiKey: configured });
      }
      const response = await this.anthropic.messages.create({
        model: this.config.get<string>('MEASUREMENT_CLAUDE_MODEL', 'claude-opus-5'),
        max_tokens: 700,
        system:
          'You compare how different AI models describe the same company. Identify factual or descriptor divergence between the answers: who the company serves, what it does, category, claims. Reply with a 2-3 sentence verdict; start with "Aligned:" or "Divergent:".',
        messages: [
          {
            role: 'user',
            content:
              answers
                .map((a) => 'MODEL ' + a.provider.toUpperCase() + ' ANSWER:\n' + a.text.slice(0, 1500))
                .join('\n\n') + '\n\nCompany: ' + entityName,
          },
        ],
      });
      return response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');
    } catch (err) {
      this.logger.error('Divergence judge failed: ' + (err as Error).message);
      return 'judge-failed: ' + (err as Error).message;
    }
  }

  // ─── Entity Audit Summary ──────────────────────────────────────

  /**
   * Get the full entity audit summary for a project.
   */
  async getAuditSummary(projectId: string) {
    const entityAudit = await this.prisma.entityAudit.findFirst({
      where: { projectId },
      include: {
        entities: {
          orderBy: { createdAt: 'asc' },
          include: {
            schemaChecks: { orderBy: { checkedAt: 'desc' } },
            platformRecords: true,
            modelDiffs: { orderBy: { createdAt: 'desc' } },
          },
        },
      },
    });

    if (!entityAudit) {
      return {
        id: '',
        projectId,
        createdAt: new Date().toISOString(),
        entities: [],
      };
    }

    return {
      id: entityAudit.id,
      projectId,
      createdAt: entityAudit.createdAt.toISOString(),
      entities: entityAudit.entities,
    };
  }
}
