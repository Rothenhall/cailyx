/**
 * Writing Style Service — P09 (platform_improvement_plan.md §13.8).
 *
 * A versioned, editable style record OWNED BY CONTENT — never a mutation of
 * `PresenceBrandVoice` (digital-presence's read-only "extracted suggestion"
 * table, P05). Same draft->confirm discipline as BusinessProfileService:
 * confirming INSERTs a new row carrying confirmedBy/confirmedAt and leaves
 * the draft untouched, so a later edit can never quietly change what a past
 * confirmation meant. A new PresenceBrandVoice row is surfaced as a
 * *suggestion* only — it never overwrites the active confirmed style.
 *
 * @module writing-style.service
 */

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import type { SaveWritingStyleDraftDto } from './dto/writing-style.dto';
import type { WritingStyleFields, WritingStyleProfileDto, WritingStyleSuggestionDto } from './writing-style.types';

const MIN_SAMPLE_FOR_SUGGESTION = 5;

type Row = Awaited<ReturnType<PrismaService['writingStyleProfile']['findFirst']>>;

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Deterministic fingerprint of the substantive style content — used to PROVE a pinned GenerationJob used exactly this content, without copying it whole. */
export function fingerprintStyle(fields: WritingStyleFields): string {
  const canonical = JSON.stringify({
    summary: fields.summary ?? '',
    tone: fields.tone ?? '',
    preferredWords: [...fields.preferredWords].sort(),
    avoidWords: [...fields.avoidWords].sort(),
    exampleSentences: fields.exampleSentences,
    ctaPreferences: fields.ctaPreferences ?? '',
    formality: fields.formality,
    audience: fields.audience ?? '',
    channelDifferences: fields.channelDifferences,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

@Injectable()
export class WritingStyleService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Reads ──────────────────────────────────────────────────────────

  /** The active confirmed style (highest confirmed version), or null. Generation must call THIS, never `listVersions`. */
  async getActive(projectId: string): Promise<WritingStyleProfileDto | null> {
    const row = await this.prisma.writingStyleProfile.findFirst({
      where: { projectId, confirmedAt: { not: null } },
      orderBy: { version: 'desc' },
    });
    if (!row) return null;
    const latest = await this.latestRow(projectId);
    return this.toDto(row, latest?.id === row.id);
  }

  async listVersions(projectId: string): Promise<{ versions: WritingStyleProfileDto[]; activeVersion: number | null }> {
    await this.requireProject(projectId);
    const rows = await this.prisma.writingStyleProfile.findMany({ where: { projectId }, orderBy: { version: 'desc' } });
    const latest = rows[0] ?? null;
    const active = rows.find((r) => r.confirmedAt !== null) ?? null;
    return {
      versions: rows.map((r) => this.toDto(r, latest?.id === r.id)),
      activeVersion: active?.version ?? null,
    };
  }

  /**
   * §13.8 "show suggestions separately, with source examples and sample
   * size". Read-only against PresenceBrandVoice — never mutated, never
   * folded in automatically. `sufficientData: false` tells the UI to offer
   * manual setup instead of implying an analyzed style exists.
   */
  async getSuggestions(projectId: string): Promise<{ suggestions: WritingStyleSuggestionDto[] }> {
    await this.requireProject(projectId);
    const rows = await this.prisma.presenceBrandVoice.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    return {
      suggestions: rows.map((r) => ({
        presenceBrandVoiceId: r.id,
        tone: parseJson<string[]>(r.tone, []),
        vocabulary: parseJson<string[]>(r.vocabulary, []),
        callToActions: parseJson<string[]>(r.callToActions, []),
        summary: r.summary,
        sampleSize: r.postSample,
        extraction: r.extraction,
        createdAt: r.createdAt.toISOString(),
        sufficientData: r.extraction === 'llm-synthesized' && r.postSample >= MIN_SAMPLE_FOR_SUGGESTION,
      })),
    };
  }

  // ─── Writes ─────────────────────────────────────────────────────────

  async saveDraft(projectId: string, dto: SaveWritingStyleDraftDto, actorId: string | undefined): Promise<WritingStyleProfileDto> {
    await this.requireProject(projectId);
    const latest = await this.latestRow(projectId);

    let suggestionSummary: string | undefined;
    if (dto.suggestionSourceId) {
      const suggestion = await this.prisma.presenceBrandVoice.findUnique({ where: { id: dto.suggestionSourceId } });
      if (!suggestion || suggestion.projectId !== projectId) {
        throw new NotFoundException(`Suggestion ${dto.suggestionSourceId} not found for project ${projectId}`);
      }
      suggestionSummary = suggestion.summary ?? undefined;
    }

    const fields: WritingStyleFields = {
      name: dto.name ?? latest?.name ?? 'Default style',
      summary: dto.summary ?? latest?.summary ?? suggestionSummary ?? null,
      tone: dto.tone ?? latest?.tone ?? null,
      preferredWords: dto.preferredWords ?? parseJson(latest?.preferredWords, []),
      avoidWords: dto.avoidWords ?? parseJson(latest?.avoidWords, []),
      exampleSentences: dto.exampleSentences ?? parseJson(latest?.exampleSentences, []),
      ctaPreferences: dto.ctaPreferences ?? latest?.ctaPreferences ?? null,
      formality: dto.formality ?? latest?.formality ?? 'neutral',
      audience: dto.audience ?? latest?.audience ?? null,
      channelDifferences: dto.channelDifferences ?? parseJson(latest?.channelDifferences, {}),
    };

    const nextVersion = (latest?.version ?? 0) + 1;
    const row = await this.prisma.writingStyleProfile.create({
      data: {
        projectId,
        version: nextVersion,
        name: fields.name,
        summary: fields.summary,
        tone: fields.tone,
        preferredWords: JSON.stringify(fields.preferredWords),
        avoidWords: JSON.stringify(fields.avoidWords),
        exampleSentences: JSON.stringify(fields.exampleSentences),
        ctaPreferences: fields.ctaPreferences,
        formality: fields.formality,
        audience: fields.audience,
        channelDifferences: JSON.stringify(fields.channelDifferences),
        sourceType: dto.suggestionSourceId ? 'suggested-accepted' : 'manual',
        suggestionSourceId: dto.suggestionSourceId ?? null,
        fingerprint: fingerprintStyle(fields),
        createdBy: actorId ?? null,
      },
    });
    return this.toDto(row, true);
  }

  /**
   * Confirm a draft. INSERTs a new row carrying confirmedBy/confirmedAt and
   * leaves the draft untouched — same discipline as BusinessProfile.confirm,
   * and for the same reason: the draft is the record of what was shown to
   * the confirming human, and generation's pinned `writingStyleVersion` must
   * always resolve to something immutable.
   */
  async confirm(projectId: string, version: number | undefined, actorId: string): Promise<WritingStyleProfileDto> {
    await this.requireProject(projectId);
    const latest = await this.latestRow(projectId);

    let candidate: Row;
    if (version !== undefined) {
      candidate = await this.prisma.writingStyleProfile.findFirst({ where: { projectId, version } });
      if (!candidate) throw new NotFoundException(`Writing style version ${version} not found for project ${projectId}`);
    } else {
      candidate = await this.prisma.writingStyleProfile.findFirst({ where: { projectId, confirmedAt: null }, orderBy: { version: 'desc' } });
    }
    if (!candidate) {
      throw new ConflictException(`Nothing to confirm for project ${projectId}. Save a draft first.`);
    }
    if (candidate.confirmedAt !== null) {
      throw new ConflictException(`Version ${candidate.version} is already confirmed.`);
    }

    const nextVersion = (latest?.version ?? 0) + 1;
    const row = await this.prisma.writingStyleProfile.create({
      data: {
        projectId,
        version: nextVersion,
        name: candidate.name,
        summary: candidate.summary,
        tone: candidate.tone,
        preferredWords: candidate.preferredWords,
        avoidWords: candidate.avoidWords,
        exampleSentences: candidate.exampleSentences,
        ctaPreferences: candidate.ctaPreferences,
        formality: candidate.formality,
        audience: candidate.audience,
        channelDifferences: candidate.channelDifferences,
        sourceType: candidate.sourceType,
        suggestionSourceId: candidate.suggestionSourceId,
        fingerprint: candidate.fingerprint,
        confirmedBy: actorId,
        confirmedAt: new Date(),
        createdBy: candidate.createdBy,
      },
    });
    return this.toDto(row, true);
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private async latestRow(projectId: string): Promise<Row> {
    return this.prisma.writingStyleProfile.findFirst({ where: { projectId }, orderBy: { version: 'desc' } });
  }

  private async requireProject(projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
  }

  private toDto(row: NonNullable<Row>, isLatest: boolean): WritingStyleProfileDto {
    return {
      id: row.id,
      projectId: row.projectId,
      version: row.version,
      name: row.name,
      summary: row.summary,
      tone: row.tone,
      preferredWords: parseJson(row.preferredWords, []),
      avoidWords: parseJson(row.avoidWords, []),
      exampleSentences: parseJson(row.exampleSentences, []),
      ctaPreferences: row.ctaPreferences,
      formality: row.formality,
      audience: row.audience,
      channelDifferences: parseJson(row.channelDifferences, {}),
      sourceType: row.sourceType as 'manual' | 'suggested-accepted',
      suggestionSourceId: row.suggestionSourceId,
      fingerprint: row.fingerprint ?? fingerprintStyle({
        name: row.name,
        summary: row.summary,
        tone: row.tone,
        preferredWords: parseJson(row.preferredWords, []),
        avoidWords: parseJson(row.avoidWords, []),
        exampleSentences: parseJson(row.exampleSentences, []),
        ctaPreferences: row.ctaPreferences,
        formality: row.formality,
        audience: row.audience,
        channelDifferences: parseJson(row.channelDifferences, {}),
      }),
      confirmedBy: row.confirmedBy,
      confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
      isLatest,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
