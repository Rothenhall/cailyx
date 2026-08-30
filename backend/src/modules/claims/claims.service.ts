/**
 * Claims Service — the claims-discipline gate (FR-9.4).
 *
 * Hard product guardrail: no numeric claim leaves the building without a
 * source and a grade; banned phrasings are blocked at generation; single-run
 * results are never phrased as rates. The check is deterministic; grading
 * consults provenance first and only widens on request.
 *
 * Grades:
 *  - A: the number came from this project's own measurement engine (n>=5).
 *  - B: the number is supported by >= 2 independent external sources.
 *  - C: single external source (usable, must stay attributed).
 *
 * @module claims.service
 */

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import {
  BANNED_PHRASES,
  CHECK_RESULTS,
  CLAIM_STATUSES,
  GRADES,
} from './claims.types';
import type { BannedHit, CheckReport, CheckResult, ClaimGrade, ClaimStatus } from './claims.types';

/** Regex for numeric-looking statements (percentages, counts, money, "x times"). */
const NUMERIC_PATTERN = /(?:\d+(?:\.\d+)?%|\$\s?\d[\d,.]*|\b\d+(?:\.\d+)?\s?(?:x|x)\b|\b\d[\d,.]{2,}\b)/g;

/** Copy that states a rate/percentage — needs multi-run provenance (FR-9.4). */
const RATE_PATTERN = /\d+(?:\.\d+)?\s*%/;

@Injectable()
export class ClaimsService {
  private readonly logger = new Logger(ClaimsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Discipline check (deterministic) ─────────────────────────

  /**
   * Run the claims-discipline filter over arbitrary copy. Deterministic —
   * used post-generation by findings, and via the API for any text.
   */
  checkCopy(copy: string, opts?: { allowRates?: boolean }): CheckReport {
    const banned = this.findBanned(copy);
    const numericClaims = this.extractNumeric(copy);
    const singleRunRate = !opts?.allowRates && RATE_PATTERN.test(copy);

    let result: CheckResult = 'passed';
    const violations: string[] = [];

    if (banned.length > 0) {
      result = 'banned-phrase';
      for (const hit of banned) violations.push('Banned phrase: "' + hit.match + '" (matches "' + hit.phrase + '")');
    }
    if (numericClaims.length > 0) {
      // Numbers are fine while un-graded at check level; approval requires a grade.
      violations.push(numericClaims.length + ' numeric statement(s) require a graded source before approval');
    }
    if (singleRunRate) {
      result = result === 'banned-phrase' ? result : 'single-run-rate';
      violations.push('Copy states a rate/percentage — rates require n>=5 provenance (single-run results are never phrased as rates)');
    }

    if (result === 'passed' && (numericClaims.length > 0 || singleRunRate)) {
      result = singleRunRate ? 'single-run-rate' : 'ungraded-number';
    }

    return { result, banned, numericClaims, singleRunRate, violations };
  }

  // ─── Claim CRUD + grading ─────────────────────────────────────

  /**
   * Check + register a claim. The copy is discipline-checked immediately;
   * claims with banned phrases are stored `blocked`, others `draft`.
   */
  async createClaim(
    projectId: string,
    input: { statement: string; sourceUrl?: string; sourceName?: string; grade?: string; gradeReason?: string },
  ) {
    const report = this.checkCopy(input.statement);
    const grade = this.validateGrade(input.grade);
    const status: ClaimStatus = report.result === 'banned-phrase' || report.result === 'single-run-rate' ? 'blocked' : 'draft';

    const claim = await this.prisma.claim.create({
      data: {
        projectId,
        statement: input.statement,
        sourceUrl: input.sourceUrl ?? null,
        sourceName: input.sourceName ?? null,
        grade: grade ?? null,
        gradeReason: input.gradeReason ?? null,
        checkResult: report.result,
        checkJson: JSON.stringify(report),
        status,
      },
    });
    this.logger.log('Claim created ' + claim.id + ' (' + report.result + ', status: ' + status + ')');
    return { ...claim, check: report };
  }

  /**
   * Approve a claim. Hard gate (FR-9.4): requires a grade and, for graded
   * numeric claims, a source; banned-phrase or single-run-rate claims can
   * never be approved.
   * @throws BadRequestException on any discipline failure.
   */
  async approveClaim(projectId: string, claimId: string) {
    const claim = await this.prisma.claim.findFirst({ where: { id: claimId, projectId } });
    if (!claim) throw new NotFoundException('Claim not found in this project: ' + claimId);
    if (claim.checkResult === 'banned-phrase' || claim.checkResult === 'single-run-rate') {
      throw new BadRequestException('Claim failed discipline check (' + claim.checkResult + ') — cannot be approved');
    }
    if (!claim.grade) {
      await this.prisma.claim.update({
        where: { id: claim.id },
        data: { status: 'blocked', checkResult: 'ungraded-number' },
      });
      throw new BadRequestException('Claim carries numbers without a grade — assign grade A/B/C with provenance first');
    }
    const recheck = this.checkCopy(claim.statement);
    if (recheck.result !== 'passed') {
      throw new BadRequestException('Claim currently fails discipline: ' + recheck.violations.join(' | '));
    }
    const updated = await this.prisma.claim.update({
      where: { id: claim.id },
      data: { status: 'approved' },
    });
    this.logger.log('Claim approved: ' + claimId);
    return updated;
  }

  /** List claims, optionally by status. */
  async listClaims(projectId: string, status?: string) {
    const where: { projectId: string; status?: string } = { projectId };
    if (status) {
      if (!CLAIM_STATUSES.includes(status as ClaimStatus)) {
        throw new BadRequestException('Unknown status filter: ' + status);
      }
      where.status = status;
    }
    return this.prisma.claim.findMany({ where, orderBy: { createdAt: 'desc' } });
  }

  /**
   * Register an external source for a claim — used to raise a claim from
   * C to B once a second independent source exists.
   */
  async attachSource(projectId: string, claimId: string, source: { url?: string; name: string }) {
    const claim = await this.prisma.claim.findFirst({ where: { id: claimId, projectId } });
    if (!claim) throw new NotFoundException('Claim not found in this project: ' + claimId);

    // Reconstruct the full source set: previously attached sources + the
    // claim's own registered source + the one being attached now.
    const sources = this.parseSources(claim.checkJson);
    if (claim.sourceName && !sources.some((s) => s.name === claim.sourceName)) {
      sources.push({ url: claim.sourceUrl ?? null, name: claim.sourceName });
    }
    if (!sources.some((s) => s.name === source.name)) {
      sources.push({ url: source.url ?? null, name: source.name });
    }

    // Provenance rule: 1 external source -> at most C; >= 2 independent -> B.
    const existingGrade = (claim.grade ?? '').toUpperCase() as ClaimGrade;
    const inferred: ClaimGrade | null =
      sources.length >= 2 ? 'B' : existingGrade || (sources.length === 1 ? 'C' : null);
    const grade: ClaimGrade | null = GRADES.includes(inferred) ? inferred : GRADES.includes(existingGrade) ? existingGrade : null;

    // Preserve the discipline report under `report`, keep `sources` alongside.
    const updated = await this.prisma.claim.update({
      where: { id: claim.id },
      data: {
        checkJson: JSON.stringify({ report: this.safeParseReport(claim.checkJson), sources }),
        grade,
        gradeReason:
          grade === 'B'
            ? 'Backed by ' + sources.length + ' independent sources'
            : claim.gradeReason,
      },
    });
    return updated;
  }

  /** Read the full discipline report stored on a claim (checkJson unwrapped). */
  async getClaim(projectId: string, claimId: string) {
    const claim = await this.prisma.claim.findFirst({ where: { id: claimId, projectId } });
    if (!claim) throw new NotFoundException('Claim not found in this project: ' + claimId);
    const parsed: unknown = this.safeParseReport(claim.checkJson);
    const stored = claim.checkJson ? (JSON.parse(claim.checkJson) as { sources?: unknown; report?: unknown }) : null;
    return {
      ...claim,
      checkJson: undefined,
      check: parsed ?? {},
      sources: Array.isArray(stored?.sources) ? stored.sources : [],
    };
  }

  // ─── Privates ─────────────────────────────────────────────────

  /** Case-insensitive banned-phrase scan. */
  private findBanned(copy: string): BannedHit[] {
    const hits: BannedHit[] = [];
    for (const phrase of BANNED_PHRASES) {
      const idx = copy.toLowerCase().indexOf(phrase.toLowerCase());
      if (idx >= 0) {
        hits.push({ phrase, match: copy.slice(idx, idx + phrase.length) });
      }
    }
    return hits;
  }

  /** Numeric statements present in the copy (deduped). */
  private extractNumeric(copy: string): string[] {
    const matches = copy.match(NUMERIC_PATTERN) ?? [];
    return [...new Set(matches)];
  }

  /** Sources array from checkJson ({sources:[...]} after an attach); [] when absent. */
  private parseSources(checkJson: string | null | undefined): Array<{ url: string | null; name: string }> {
    if (!checkJson) return [];
    try {
      const parsed: unknown = JSON.parse(checkJson);
      const sources = (parsed as { sources?: unknown }).sources;
      if (!Array.isArray(sources)) return [];
      return sources
        .filter(
          (s): s is { url: string | null; name: string } =>
            typeof s === 'object' && s !== null && typeof (s as { name?: unknown }).name === 'string',
        )
        .map((s) => ({ url: (s as { url?: unknown }).url as string | null, name: s.name }));
    } catch {
      return [];
    }
  }

  /** CheckJson may hold a CheckReport, or {report, sources} after an attach. */
  private safeParseReport(checkJson: string | null | undefined): CheckReport | null {
    if (!checkJson) return null;
    try {
      const parsed: unknown = JSON.parse(checkJson);
      const candidate = (parsed as { report?: unknown }).report ?? parsed;
      if (
        candidate && typeof candidate === 'object' && typeof (candidate as { result?: unknown }).result === 'string'
      ) {
        return candidate as CheckReport;
      }
    } catch {
      // fall through
    }
    return null;
  }

  private validateGrade(grade?: string): ClaimGrade | null {
    if (grade === undefined || grade === null) return null;
    const upper = grade.toUpperCase() as ClaimGrade;
    if (!GRADES.includes(upper)) {
      throw new BadRequestException('Grade must be one of: ' + GRADES.join(', ') + ' (A = own n>=5 measurement, B = 2+ sources, C = single source)');
    }
    return upper;
  }

  /** Grade provenance note shown in the API. */
  gradeLabel(grade: ClaimGrade | null): string | null {
    if (!grade) return null;
    return {
      A: 'Own measurement (n>=5)',
      B: '2+ independent sources',
      C: 'Single source',
    }[grade];
  }

  /** Filter guard used by controllers. */
  assertCheckResult(value: string): CheckResult {
    if (!CHECK_RESULTS.includes(value as CheckResult)) {
      throw new BadRequestException('Unknown check result: ' + value);
    }
    return value as CheckResult;
  }
}