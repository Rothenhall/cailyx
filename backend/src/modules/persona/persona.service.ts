/**
 * Persona Service — synthetic buyer persona generator (Agent #1, Swarm layer).
 *
 * Two ways to make a persona:
 *   - `generate()` — deterministic builder ({@link persona.generator}) from the
 *     project's own context, optionally refined by one constrained LLM pass.
 *   - `create()` — a hand-authored persona.
 *
 * Personas are the research identities the `journey` module fans out over. They
 * are bounded per project (`PERSONA_MAX_PER_PROJECT`, default 100) so nothing
 * spawns an unbounded swarm, and the LLM refinement is cost-capped
 * (`PERSONA_MAX_COST_PER_GENERATE`, default $1.00) — over budget, the remaining
 * personas keep their deterministic copy rather than failing the batch.
 *
 * Lifecycle mirrors `query-set`: draft → active → archived. Only drafts mutate.
 *
 * @module persona.service
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../database/prisma.service';
import { generatePersona, planGeneration } from './persona.generator';
import { PERSONA_ROLES } from './persona.types';
import type {
  CreatePersonaInput,
  GeneratePersonasInput,
  PersonaDto,
  PersonaGenerationContext,
  PersonaProfile,
  PersonaRole,
  PersonaStatus,
  UpdatePersonaInput,
} from './persona.types';

/** Default ceiling on personas per project — a swarm-fan-out guard. */
const DEFAULT_MAX_PER_PROJECT = 100;
/** Default USD budget for the LLM refinement pass of a single generate() call. */
const DEFAULT_MAX_COST_PER_GENERATE = 1.0;
/** Opus fallback $/MTok — matches measurement/anthropic.adapter. */
const OPUS_INPUT_PER_MTOK = 5;
const OPUS_OUTPUT_PER_MTOK = 25;

@Injectable()
export class PersonaService {
  private readonly logger = new Logger(PersonaService.name);
  private anthropic: Anthropic | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** List a project's personas (newest first), optionally filtered by status. */
  async list(projectId: string, status?: PersonaStatus): Promise<PersonaDto[]> {
    await this.ensureProject(projectId);
    const rows = await this.prisma.persona.findMany({
      where: { projectId, ...(status ? { status } : {}) },
      orderBy: [{ createdAt: 'desc' }],
    });
    return rows.map((r) => this.toDto(r));
  }

  /** One persona or 404. */
  async get(id: string): Promise<PersonaDto> {
    const row = await this.prisma.persona.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Persona not found: ' + id);
    return this.toDto(row);
  }

  /**
   * Generate `count` personas for a project. Deterministic by default; set
   * `useLlm` to refine each with one constrained Anthropic call.
   *
   * @throws NotFoundException          project missing.
   * @throws ConflictException          project is already at its persona cap.
   * @throws ServiceUnavailableException `useLlm` requested without ANTHROPIC_API_KEY.
   */
  async generate(projectId: string, input: GeneratePersonasInput): Promise<{ personas: PersonaDto[]; llmRefined: number; llmCostUsd: number; capped: boolean }> {
    const project = await this.ensureProject(projectId);

    // Capability gate before business rules: "this feature is unavailable" (503)
    // is a clearer signal than "you are at cap" (409) when both are true.
    const useLlm = input.useLlm === true;
    if (useLlm && !this.config.get<string>('ANTHROPIC_API_KEY')) {
      throw new ServiceUnavailableException(
        'ANTHROPIC_API_KEY not configured — persona LLM refinement unavailable (omit useLlm for the deterministic generator)',
      );
    }

    const cap = this.maxPerProject();
    const existingCount = await this.prisma.persona.count({ where: { projectId } });
    const room = cap - existingCount;
    if (room <= 0) {
      throw new ConflictException(
        `Persona cap reached for project ${projectId} (${existingCount}/${cap}). Archive or delete personas first, or raise PERSONA_MAX_PER_PROJECT.`,
      );
    }
    const want = Math.min(input.count, room);
    const capped = want < input.count;

    const roles = this.resolveRoles(input.roles);
    const ctx = this.contextFor(project);
    const plan = planGeneration(want, existingCount, roles);

    const costBudget = this.maxCostPerGenerate();
    let llmCostUsd = 0;
    let llmRefined = 0;
    const created: PersonaDto[] = [];

    for (const slot of plan) {
      const { profile, seed } = generatePersona(slot.role, slot.index, ctx);

      let finalProfile = profile;
      let source: 'generated' | 'generated-llm' = 'generated';
      let generationModel: string | null = null;

      if (useLlm && llmCostUsd < costBudget) {
        try {
          const refined = await this.refineWithLlm(profile, ctx);
          finalProfile = refined.profile;
          llmCostUsd += refined.costUsd;
          source = 'generated-llm';
          generationModel = refined.model;
          llmRefined++;
        } catch (err) {
          this.logger.warn(
            `LLM refine failed for ${slot.role}#${slot.index} (${(err as Error).message}) — keeping deterministic copy`,
          );
        }
      }

      const row = await this.prisma.persona.create({
        data: {
          projectId,
          label: finalProfile.label,
          role: finalProfile.role,
          seniority: finalProfile.seniority,
          companyStage: finalProfile.companyStage,
          awareness: finalProfile.awareness,
          primaryGoal: finalProfile.primaryGoal,
          researchObjective: finalProfile.researchObjective,
          painPoints: JSON.stringify(finalProfile.painPoints),
          buyingTriggers: JSON.stringify(finalProfile.buyingTriggers),
          objections: JSON.stringify(finalProfile.objections),
          vocabulary: JSON.stringify(finalProfile.vocabulary),
          status: 'draft',
          source,
          generationModel,
          seed,
        },
      });
      created.push(this.toDto(row));
    }

    this.logger.log(
      `Generated ${created.length} persona(s) for project ${projectId} ` +
        `(${llmRefined} LLM-refined, $${llmCostUsd.toFixed(4)}${capped ? ', batch capped at project limit' : ''})`,
    );
    return { personas: created, llmRefined, llmCostUsd: Number(llmCostUsd.toFixed(6)), capped };
  }

  /** Hand-author a persona (always lands as a draft, source = manual). */
  async create(projectId: string, input: CreatePersonaInput): Promise<PersonaDto> {
    await this.ensureProject(projectId);
    const cap = this.maxPerProject();
    const existingCount = await this.prisma.persona.count({ where: { projectId } });
    if (existingCount >= cap) {
      throw new ConflictException(
        `Persona cap reached for project ${projectId} (${existingCount}/${cap}).`,
      );
    }
    const row = await this.prisma.persona.create({
      data: {
        projectId,
        label: input.label,
        role: input.role,
        seniority: input.seniority ?? 'lead',
        companyStage: input.companyStage ?? 'growth',
        awareness: input.awareness ?? 'problem-aware',
        primaryGoal: input.primaryGoal,
        researchObjective: input.researchObjective,
        painPoints: JSON.stringify(input.painPoints ?? []),
        buyingTriggers: JSON.stringify(input.buyingTriggers ?? []),
        objections: JSON.stringify(input.objections ?? []),
        vocabulary: JSON.stringify(input.vocabulary ?? []),
        status: 'draft',
        source: 'manual',
      },
    });
    this.logger.log(`Persona created manually for project ${projectId} (${input.role})`);
    return this.toDto(row);
  }

  /** Patch a draft persona. Active/archived personas are immutable. */
  async update(id: string, patch: UpdatePersonaInput): Promise<PersonaDto> {
    await this.ensureDraft(id);
    const data: Record<string, unknown> = {};
    if (patch.label !== undefined) data.label = patch.label;
    if (patch.seniority !== undefined) data.seniority = patch.seniority;
    if (patch.companyStage !== undefined) data.companyStage = patch.companyStage;
    if (patch.awareness !== undefined) data.awareness = patch.awareness;
    if (patch.primaryGoal !== undefined) data.primaryGoal = patch.primaryGoal;
    if (patch.researchObjective !== undefined) data.researchObjective = patch.researchObjective;
    if (patch.painPoints !== undefined) data.painPoints = JSON.stringify(patch.painPoints);
    if (patch.buyingTriggers !== undefined) data.buyingTriggers = JSON.stringify(patch.buyingTriggers);
    if (patch.objections !== undefined) data.objections = JSON.stringify(patch.objections);
    if (patch.vocabulary !== undefined) data.vocabulary = JSON.stringify(patch.vocabulary);

    const row = await this.prisma.persona.update({ where: { id }, data });
    return this.toDto(row);
  }

  /** Draft → active. Active personas are what `journey` fans out over. */
  async activate(id: string): Promise<PersonaDto> {
    const persona = await this.prisma.persona.findUnique({ where: { id } });
    if (!persona) throw new NotFoundException('Persona not found: ' + id);
    if (persona.status === 'active') return this.toDto(persona);
    if (persona.status === 'archived') {
      throw new ConflictException(`Persona ${id} is archived — cannot re-activate.`);
    }
    const row = await this.prisma.persona.update({ where: { id }, data: { status: 'active' } });
    this.logger.log(`Persona ${id} activated (project=${persona.projectId})`);
    return this.toDto(row);
  }

  /** Any status → archived. Frees a slot against the project cap is NOT implied
   * (archived rows still count) — delete to reclaim budget. */
  async archive(id: string): Promise<PersonaDto> {
    const persona = await this.prisma.persona.findUnique({ where: { id } });
    if (!persona) throw new NotFoundException('Persona not found: ' + id);
    const row = await this.prisma.persona.update({ where: { id }, data: { status: 'archived' } });
    return this.toDto(row);
  }

  /** Hard-delete a persona (reclaims one slot against the project cap). */
  async remove(id: string): Promise<{ removed: string }> {
    const persona = await this.prisma.persona.findUnique({ where: { id } });
    if (!persona) throw new NotFoundException('Persona not found: ' + id);
    await this.prisma.persona.delete({ where: { id } });
    return { removed: id };
  }

  /** Full export — the project owns its persona set (parity with query-set). */
  async export(projectId: string): Promise<PersonaDto[]> {
    await this.ensureProject(projectId);
    const rows = await this.prisma.persona.findMany({
      where: { projectId },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((r) => this.toDto(r));
  }

  // ─── internals ────────────────────────────────────────────────

  private resolveRoles(roles?: string[]): PersonaRole[] {
    if (!roles || roles.length === 0) return [...PERSONA_ROLES];
    const allowed = new Set<string>(PERSONA_ROLES);
    const filtered = roles.filter((r) => allowed.has(r)) as PersonaRole[];
    return filtered.length > 0 ? filtered : [...PERSONA_ROLES];
  }

  private contextFor(project: { id: string; category: string | null; name: string; competitors: string | null }): PersonaGenerationContext {
    let competitors: string[] = [];
    if (project.competitors) {
      try {
        const parsed = JSON.parse(project.competitors) as Array<{ name?: string } | string>;
        competitors = parsed
          .map((c) => (typeof c === 'string' ? c : c?.name))
          .filter((n): n is string => typeof n === 'string' && n.trim().length > 0);
      } catch {
        competitors = [];
      }
    }
    return {
      projectId: project.id,
      category: project.category?.trim() || 'this category',
      brand: project.name,
      competitors,
    };
  }

  /**
   * One constrained Anthropic call: rewrite only the freeform strings of a
   * deterministic profile so they sound like a specific human, keeping the
   * taxonomy (role / seniority / stage / awareness) fixed.
   */
  private async refineWithLlm(
    profile: PersonaProfile,
    ctx: PersonaGenerationContext,
  ): Promise<{ profile: PersonaProfile; costUsd: number; model: string }> {
    const model = this.config.get<string>('PERSONA_LLM_MODEL', 'claude-opus-5');
    const client = this.ensureClient();

    const system =
      'You sharpen synthetic B2B buyer personas for market research. You are given a persona ' +
      'draft as JSON. Rewrite ONLY the freeform text fields so they read as one specific real ' +
      'person in that role — concrete, first-person where natural, no marketing voice. Do NOT ' +
      'change role, seniority, companyStage, or awareness. Return ONLY minified JSON with keys: ' +
      'label, primaryGoal, researchObjective, painPoints (string[]), buyingTriggers (string[]), ' +
      'objections (string[]), vocabulary (string[] — short search-box phrases). Keep array lengths ' +
      'the same as the input.';

    const user = JSON.stringify({
      context: { category: ctx.category, brand: ctx.brand, competitors: ctx.competitors },
      persona: {
        label: profile.label,
        role: profile.role,
        seniority: profile.seniority,
        companyStage: profile.companyStage,
        awareness: profile.awareness,
        primaryGoal: profile.primaryGoal,
        researchObjective: profile.researchObjective,
        painPoints: profile.painPoints,
        buyingTriggers: profile.buyingTriggers,
        objections: profile.objections,
        vocabulary: profile.vocabulary,
      },
    });

    const res = await client.messages.create({
      model,
      max_tokens: 1200,
      system,
      messages: [{ role: 'user', content: user }],
    });

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    const parsed = this.parseRefinement(text);
    const inputTokens = res.usage?.input_tokens ?? 0;
    const outputTokens = res.usage?.output_tokens ?? 0;
    const costUsd =
      (inputTokens / 1_000_000) * OPUS_INPUT_PER_MTOK + (outputTokens / 1_000_000) * OPUS_OUTPUT_PER_MTOK;

    return {
      model,
      costUsd,
      profile: {
        ...profile,
        label: parsed.label ?? profile.label,
        primaryGoal: parsed.primaryGoal ?? profile.primaryGoal,
        researchObjective: parsed.researchObjective ?? profile.researchObjective,
        painPoints: parsed.painPoints ?? profile.painPoints,
        buyingTriggers: parsed.buyingTriggers ?? profile.buyingTriggers,
        objections: parsed.objections ?? profile.objections,
        vocabulary: parsed.vocabulary ?? profile.vocabulary,
      },
    };
  }

  /** Tolerant JSON extraction — model may wrap the object in prose or a fence. */
  private parseRefinement(text: string): Partial<Record<
    'label' | 'primaryGoal' | 'researchObjective' | 'painPoints' | 'buyingTriggers' | 'objections' | 'vocabulary',
    string & string[]
  >> {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return {};
    try {
      const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
      const arr = (v: unknown) =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : undefined;
      return {
        label: str(obj.label) as never,
        primaryGoal: str(obj.primaryGoal) as never,
        researchObjective: str(obj.researchObjective) as never,
        painPoints: arr(obj.painPoints) as never,
        buyingTriggers: arr(obj.buyingTriggers) as never,
        objections: arr(obj.objections) as never,
        vocabulary: arr(obj.vocabulary) as never,
      };
    } catch {
      return {};
    }
  }

  private ensureClient(): Anthropic {
    if (!this.anthropic) {
      this.anthropic = new Anthropic({ apiKey: this.config.get<string>('ANTHROPIC_API_KEY') || undefined });
    }
    return this.anthropic;
  }

  private maxPerProject(): number {
    const raw = Number(this.config.get<string>('PERSONA_MAX_PER_PROJECT'));
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_PER_PROJECT;
  }

  private maxCostPerGenerate(): number {
    const raw = Number(this.config.get<string>('PERSONA_MAX_COST_PER_GENERATE'));
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_COST_PER_GENERATE;
  }

  private async ensureProject(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + projectId);
    return project;
  }

  private async ensureDraft(id: string) {
    const persona = await this.prisma.persona.findUnique({ where: { id } });
    if (!persona) throw new NotFoundException('Persona not found: ' + id);
    if (persona.status !== 'draft') {
      throw new ConflictException(
        `Persona ${id} is ${persona.status} — immutable. Only drafts can be edited.`,
      );
    }
    return persona;
  }

  private toDto(row: {
    id: string;
    projectId: string;
    label: string;
    role: string;
    seniority: string;
    companyStage: string;
    awareness: string;
    primaryGoal: string;
    researchObjective: string;
    painPoints: string;
    buyingTriggers: string;
    objections: string;
    vocabulary: string;
    status: string;
    source: string;
    generationModel: string | null;
    seed: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): PersonaDto {
    const list = (raw: string): string[] => {
      try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
      } catch {
        return [];
      }
    };
    return {
      id: row.id,
      projectId: row.projectId,
      label: row.label,
      role: row.role,
      seniority: row.seniority,
      companyStage: row.companyStage,
      awareness: row.awareness,
      primaryGoal: row.primaryGoal,
      researchObjective: row.researchObjective,
      painPoints: list(row.painPoints),
      buyingTriggers: list(row.buyingTriggers),
      objections: list(row.objections),
      vocabulary: list(row.vocabulary),
      status: row.status,
      source: row.source,
      generationModel: row.generationModel,
      seed: row.seed,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
