/**
 * DiagnosticIntakeService — the public half of G16: the abuse-protected
 * diagnostic request (PB03), its challenge, and the token-scoped scorecard CTA
 * capture (PB02).
 *
 * Everything here is reachable **without a session**, so it is written to
 * assume the caller is hostile until three independent gates say otherwise:
 *
 * | Gate | What it stops | Where |
 * |---|---|---|
 * | `@Throttle` on every route | IP-level floods | controller |
 * | signed, expiring, single-use challenge **plus proof of work** | scripted bulk submission | `lib/challenge.util` |
 * | per-domain cap (3 per 24h) | one attacker spread across many IPs | this service |
 *
 * and then one consent gate, which is not abuse control: a request that carries
 * contact details must carry `consent: true`, because the whole point of the
 * record is that the person agreed to be contacted. A submission without it is
 * rejected with the sentence it violated, not silently accepted.
 *
 * What this service deliberately does **not** do is run the expensive operator
 * intake. `POST /api/intake/subject` fetches a site, parses its schema and
 * seeds competitors — that stays behind the operator JWT. An accepted public
 * request creates an *unenriched* project stub, a lead, and a queued job-run
 * receipt for an operator to pick up.
 *
 * @module diagnostic-intake.service
 */

import { BadRequestException, HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { JobsService } from '../jobs/jobs.service';
import { INTAKE_CHALLENGE_BITS_ENV, INTAKE_CHALLENGE_SECRET_ENV } from './billing.service';
import {
  CHALLENGE_ALGORITHM,
  DEFAULT_CHALLENGE_TTL_SECONDS,
  DEFAULT_DIFFICULTY_BITS,
  clampDifficulty,
  issueChallenge,
  verifyChallengeToken,
  verifyProofOfWork,
  type IssuedChallenge,
} from './lib/challenge.util';
import { normalizeDomain } from './lib/domain.util';
import type { CreateDiagnosticRequestDto, ScorecardCtaDto } from './dto/billing.dto';
import type { DiagnosticReceiptView } from './billing.types';

/** The task kind the public request queues. No worker handler exists yet. */
export const DIAGNOSTIC_TASK_KIND = 'diagnostic-request';
/** How many public requests one domain may generate in the window below. */
export const DOMAIN_REQUEST_CAP = 3;
/** The window the per-domain cap is measured over. */
export const DOMAIN_REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Shape of the JSON stored in the receipt run's `input`, as read back.
 * The run's `input` column is a free-form JSON object, so writing goes through
 * a `Record<string, unknown>` and this interface describes the read side.
 */
interface DiagnosticRunInput {
  domain: string;
  goal: string | null;
  contactEmail: string;
  leadId: string;
  consent: { given: true; at: string; statement: string };
  challenge: { nonce: string; algorithm: string; bits: number };
}

/** The consent sentence recorded with the submission. Versioned by its text. */
export const CONSENT_STATEMENT =
  'I agree that Cailyx may contact me about this request at the email address I supplied.';

@Injectable()
export class DiagnosticIntakeService {
  private readonly logger = new Logger(DiagnosticIntakeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly jobs: JobsService,
    private readonly activity: ActivityService,
  ) {}

  /** The challenge signing secret. Unset closes the intake rather than opening it. */
  private get challengeSecret(): string | undefined {
    return this.config.get<string>(INTAKE_CHALLENGE_SECRET_ENV) || undefined;
  }

  private get difficultyBits(): number {
    const raw = this.config.get<string>(INTAKE_CHALLENGE_BITS_ENV);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? clampDifficulty(parsed) : DEFAULT_DIFFICULTY_BITS;
  }

  /** The public scorecard funnel flag, shared with the scorecard module. */
  get scorecardPublicEnabled(): boolean {
    return this.config.get<string>('SCORECARD_PUBLIC') === '1';
  }

  // ── Challenge ───────────────────────────────────────────────────────

  /**
   * Mint a challenge for a caller that has not submitted anything yet.
   *
   * @throws ServiceUnavailableException when no challenge secret is configured
   *   — an unverifiable challenge is worse than a closed door, because it
   *   looks like protection.
   */
  issueChallengeForCaller(): IssuedChallenge & { statement: string; ttlSeconds: number } {
    const secret = this.challengeSecret;
    if (!secret) {
      throw new ServiceUnavailableException({
        error: 'intake-challenge-unconfigured',
        message: `${INTAKE_CHALLENGE_SECRET_ENV} is not set, so no challenge can be signed and verified. The public diagnostic request is closed until it is configured.`,
      });
    }
    const challenge = issueChallenge(secret, { difficultyBits: this.difficultyBits });
    return {
      ...challenge,
      ttlSeconds: DEFAULT_CHALLENGE_TTL_SECONDS,
      statement:
        `Find any string whose SHA-256 with this token has at least ${challenge.difficultyBits} leading zero bits, ` +
        `then submit the token and that string together with your domain and consent.`,
    };
  }

  // ── Public diagnostic request (PB03) ────────────────────────────────

  /**
   * Accept one public diagnostic request.
   *
   * Order is deliberate: verify the challenge *before* touching the database,
   * so a submission that fails the challenge costs one HMAC and no rows; then
   * claim the receipt (idempotency key = the challenge nonce) before writing
   * the lead, so a replayed submission returns the first receipt instead of
   * creating a second one.
   */
  async submit(dto: CreateDiagnosticRequestDto): Promise<DiagnosticReceiptView> {
    const secret = this.challengeSecret;
    if (!secret) {
      throw new ServiceUnavailableException({
        error: 'intake-challenge-unconfigured',
        message: `${INTAKE_CHALLENGE_SECRET_ENV} is not set — the public diagnostic request is closed rather than accepting unverified submissions.`,
      });
    }

    // Consent is checked first among the input rules: it is the one field
    // whose absence should stop the submission outright rather than produce a
    // half-recorded lead.
    if (dto.consent !== true) {
      throw new BadRequestException(
        `consent must be true. Submitting contact details for a diagnostic request requires agreeing that Cailyx may reply: "${CONSENT_STATEMENT}"`,
      );
    }

    const verdict = verifyChallengeToken(secret, dto.challengeToken);
    if (!verdict.valid) {
      throw new BadRequestException({
        error: 'challenge-invalid',
        reason: verdict.reason,
        message:
          verdict.reason === 'expired'
            ? 'This challenge has expired — request a new one and submit again.'
            : 'This challenge token is not one this server issued. Request a new challenge.',
      });
    }

    const work = verifyProofOfWork(dto.challengeToken, dto.challengeAnswer, verdict.difficultyBits);
    if (!work.ok) {
      throw new BadRequestException({
        error: 'challenge-unsolved',
        reason: work.reason,
        requiredBits: verdict.difficultyBits,
        achievedBits: work.bits,
        message: `The challenge is not solved yet (found ${work.bits} of the ${verdict.difficultyBits} required leading zero bits).`,
      });
    }

    const domain = normalizeDomain(dto.domain);

    // The project is the domain (find-or-create on the unique domain column),
    // so the per-domain counter is a count of this project's intake leads.
    const project = await this.findOrCreateDiagnosticProject(domain);
    await this.assertDomainUnderCap(project.id, domain);

    const leadId = randomUUID();
    const now = new Date();

    const runInput: Record<string, unknown> = {
      domain,
      goal: dto.goal ?? null,
      contactEmail: dto.contactEmail,
      leadId,
      consent: { given: true, at: now.toISOString(), statement: CONSENT_STATEMENT },
      challenge: { nonce: verdict.nonce, algorithm: CHALLENGE_ALGORITHM, bits: work.bits },
    };

    // Claim the receipt first. The nonce is the idempotency key, which is what
    // makes the challenge single-use without a nonce table.
    const claim = await this.jobs.createAndEnqueue({
      projectId: project.id,
      taskKind: DIAGNOSTIC_TASK_KIND,
      idempotencyKey: `${DIAGNOSTIC_TASK_KIND}:${verdict.nonce}`,
      trigger: 'pipeline',
      input: runInput,
      steps: [
        { name: 'received', position: 0 },
        { name: 'operator-review', position: 1 },
        { name: 'enrichment', position: 2 },
      ],
      // Nothing has been spent yet; the run is a receipt, not a purchase.
      maxCostUsd: null,
    });

    if (claim.outcome === 'existing') {
      // The same challenge was redeemed before — return the original receipt
      // rather than recording the person twice.
      const prior = await this.readReceiptFromRun(claim.run.input, claim.run.id, project.id);
      if (prior) return { ...prior, duplicate: true };
      throw new HttpException(
        {
          error: 'receipt-unreadable',
          message:
            'This challenge was already redeemed, but the original receipt could not be read back. An operator can find it in the job ledger.',
          jobRunId: claim.run.id,
        },
        HttpStatus.CONFLICT,
      );
    }

    const lead = await this.prisma.lead.create({
      data: {
        id: leadId,
        projectId: project.id,
        email: dto.contactEmail,
        name: dto.contactName ?? dto.company ?? null,
        source: 'form',
        status: 'new',
        ctaEvents: '[]',
      },
    });

    await this.activity.record({
      actor: { type: 'system', id: 'public-intake', label: 'public diagnostic request' },
      action: 'created',
      resource: { type: 'diagnostic-request', id: claim.run.id, version: DIAGNOSTIC_TASK_KIND },
      projectId: project.id,
      jobRunId: claim.run.id,
      summary: `Public diagnostic request received for ${domain}`,
      // No contact details in the audit trail: the lead row holds them, and
      // the activity feed is readable by more people than the sales pipeline.
      // No IP address either — matching the attribution route's own rule.
      changes: { domain, runOutcome: claim.outcome },
      origin: 'api',
      result: 'success',
      clientVisible: false,
    });

    return {
      receiptId: lead.id,
      projectId: project.id,
      leadId: lead.id,
      jobRunId: claim.run.id,
      status: claim.outcome === 'created' ? 'queued' : 'received',
      domain,
      contactEmail: dto.contactEmail,
      submittedAt: now.toISOString(),
      nextStep:
        claim.outcome === 'created'
          ? 'Queued for an operator. The expensive site enrichment runs operator-side, on the project this receipt created; you will be contacted at the address you supplied.'
          : 'A diagnostic run for this project was already queued, so this request was recorded against it rather than starting a second one.',
      runNotStartedReason: claim.requeueBlockedReason,
      duplicate: false,
    };
  }

  /** Read a receipt back out of a run's stored input, for a replay. */
  private async readReceiptFromRun(
    rawInput: string,
    runId: string,
    projectId: string,
  ): Promise<DiagnosticReceiptView | null> {
    let parsed: Partial<DiagnosticRunInput>;
    try {
      parsed = JSON.parse(rawInput) as Partial<DiagnosticRunInput>;
    } catch {
      return null;
    }
    if (typeof parsed.domain !== 'string' || typeof parsed.contactEmail !== 'string') return null;

    const leadId = typeof parsed.leadId === 'string' ? parsed.leadId : null;
    const lead = leadId ? await this.prisma.lead.findUnique({ where: { id: leadId } }) : null;
    if (!lead) return null;

    return {
      receiptId: lead.id,
      projectId,
      leadId: lead.id,
      jobRunId: runId,
      status: 'received',
      domain: parsed.domain,
      contactEmail: parsed.contactEmail,
      submittedAt: lead.createdAt.toISOString(),
      nextStep: 'This request had already been submitted and is already in the queue. Nothing was submitted twice.',
      runNotStartedReason: null,
      duplicate: true,
    };
  }

  /**
   * Find or create the unenriched project stub for a domain.
   *
   * `Project.domain` is unique, so this is a find-then-create keyed on the
   * normalized host: the same site always lands on one project, whether it
   * arrives from the public form or from an operator's intake later.
   */
  private async findOrCreateDiagnosticProject(domain: string): Promise<{ id: string; created: boolean }> {
    const existing = await this.prisma.project.findUnique({ where: { domain }, select: { id: true } });
    if (existing) return { id: existing.id, created: false };

    try {
      const created = await this.prisma.project.create({
        data: {
          name: domain,
          domain,
          status: 'diagnostic',
          notes: 'Created by the public diagnostic request form (G16). Not enriched — no site fetch has been run.',
        },
        select: { id: true },
      });
      return { id: created.id, created: true };
    } catch {
      // Unique-violation race with a concurrent submission for the same domain.
      const raced = await this.prisma.project.findUnique({ where: { domain }, select: { id: true } });
      if (raced) return { id: raced.id, created: false };
      throw new HttpException(
        { error: 'intake-failed', message: 'The request could not be recorded. Try again shortly.' },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Per-domain cap. IP throttling alone is defeated by a botnet, so the second
   * axis is the thing being requested: a domain can only generate a handful of
   * public requests per day, however many addresses ask for it.
   *
   * The counter is the project's own intake leads, not its job runs: a repeat
   * request for a domain whose run is still queued takes the run-lock path and
   * creates no new run, so counting runs would let that path bypass the cap
   * entirely (observed in the acceptance run before this was fixed).
   */
  private async assertDomainUnderCap(projectId: string, domain: string): Promise<void> {
    const since = new Date(Date.now() - DOMAIN_REQUEST_WINDOW_MS);
    const recent = await this.prisma.lead.count({
      where: { projectId, source: 'form', createdAt: { gte: since } },
    });
    if (recent >= DOMAIN_REQUEST_CAP) {
      throw new HttpException(
        {
          error: 'domain-cap-reached',
          message:
            `${domain} has already generated ${recent} diagnostic requests in the last 24 hours. ` +
            'Contact Cailyx directly rather than submitting another one.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  // ── Public scorecard CTA (PB02) ─────────────────────────────────────

  /**
   * Capture a CTA from a shared scorecard, keyed by the scorecard's public
   * token — the only credential a visitor on `/shared/scorecards/...` holds.
   *
   * Gated by the same `SCORECARD_PUBLIC` flag as the scorecard read itself: a
   * funnel whose public page is switched off must not keep accepting
   * conversions. Supplying an email requires `consent: true` for the same
   * reason the diagnostic request does.
   */
  async captureScorecardCta(
    publicToken: string,
    dto: ScorecardCtaDto,
  ): Promise<{ leadId: string; projectId: string; leadCreated: boolean; ctaEvents: number; nextStep: string }> {
    if (!this.scorecardPublicEnabled) {
      throw new HttpException(
        {
          error: 'public-scorecards-disabled',
          message: 'Public scorecards are disabled (SCORECARD_PUBLIC is not 1), so CTA capture is closed too.',
        },
        HttpStatus.FORBIDDEN,
      );
    }

    const run = await this.prisma.scorecardRun.findUnique({
      where: { publicToken },
      select: { id: true, projectId: true },
    });
    if (!run) throw new BadRequestException({ error: 'unknown-scorecard', message: 'Unknown scorecard link.' });

    if (dto.email && dto.consent !== true) {
      throw new BadRequestException(
        `consent must be true when an email address is supplied: "${CONSENT_STATEMENT}"`,
      );
    }

    const meta = this.serializeMeta(dto.meta);
    const existingLead = dto.email
      ? await this.prisma.lead.findFirst({ where: { projectId: run.projectId, email: dto.email } })
      : null;

    const event = { type: dto.type, at: new Date().toISOString(), meta: { ...meta, scorecardRunId: run.id } };

    if (existingLead) {
      const events = this.parseCtaEvents(existingLead.ctaEvents);
      events.push(event);
      const updated = await this.prisma.lead.update({
        where: { id: existingLead.id },
        data: { ctaEvents: JSON.stringify(events), scorecardRunId: run.id, ...(dto.name ? { name: dto.name } : {}) },
      });
      return {
        leadId: updated.id,
        projectId: run.projectId,
        leadCreated: false,
        ctaEvents: events.length,
        nextStep: 'Recorded against the existing lead for this project.',
      };
    }

    const created = await this.prisma.lead.create({
      data: {
        projectId: run.projectId,
        email: dto.email ?? `scorecard-${run.id}@no-address.cailyx.invalid`,
        name: dto.name ?? null,
        source: 'scorecard',
        status: 'new',
        scorecardRunId: run.id,
        ctaEvents: JSON.stringify([event]),
      },
    });

    return {
      leadId: created.id,
      projectId: run.projectId,
      leadCreated: true,
      ctaEvents: 1,
      nextStep: dto.email
        ? 'Recorded as a new lead for this project. An operator will follow up at the address supplied.'
        : 'Recorded against this scorecard. Supply an email address (with consent) if you want a reply.',
    };
  }

  private parseCtaEvents(raw: string): Array<{ type: string; at: string; meta: Record<string, unknown> }> {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as Array<{ type: string; at: string; meta: Record<string, unknown> }>) : [];
    } catch {
      return [];
    }
  }

  /** Cap free-form CTA context so the column cannot be used as storage. */
  private serializeMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!meta) return {};
    const json = JSON.stringify(meta);
    if (json.length > 2000) {
      throw new BadRequestException('meta is too large (2 KB serialized maximum)');
    }
    return meta;
  }

  /** Exposed for the controller so an unconfigured intake reports itself. */
  capability(): { configured: boolean; reason: string | null; challengeDifficultyBits: number } {
    const configured = !!this.challengeSecret;
    return {
      configured,
      reason: configured
        ? null
        : `${INTAKE_CHALLENGE_SECRET_ENV} is not set — the public diagnostic request is closed until it is.`,
      challengeDifficultyBits: configured ? this.difficultyBits : 0,
    };
  }
}
