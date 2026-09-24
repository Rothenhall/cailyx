/**
 * AEO Stance Service — judges *how* an answer positioned the client.
 *
 * The counted layer (`measurement`) can already tell you whether the brand was
 * named and whether the domain was cited. It cannot tell you whether ChatGPT
 * led with the client, listed them third behind two competitors, or named them
 * only to warn the buyer off. That is what this pass adds.
 *
 * **Provenance rule (D4, `docs/analysis/aeo-audit.md`).** Everything produced
 * here is an LLM *opinion* and is stored in its own table, never merged into a
 * rate. Rates come from counting; stance comes from reading. The verdict keeps
 * the two blocks separate so no downstream consumer can confuse them, and every
 * judgement carries a verbatim quote so a human can check the call.
 *
 * Runs on whichever provider `AeoLlmService` resolves — OpenRouter with a small
 * cheap model by default. With none configured this pass does not run and the
 * audit reports `judged.available = false` with the reason; it never fabricates
 * a stance.
 *
 * @module aeo-stance.service
 */

import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { FetcherService } from '../fetcher/fetcher.service';
import { AeoLlmService } from './aeo-llm.service';
import { STANCES } from './aeo-audit.types';
import type { PromptDimension, Stance, StanceVerdict } from './aeo-audit.types';
import { PROMPT_DIMENSIONS } from './aeo-audit.types';

/**
 * Names an AI answer surfaces that are never themselves a competitor, no
 * matter how often they're mentioned: the LLM platforms doing the answering,
 * review/rating sites cited as a source rather than a recommended vendor, and
 * general-purpose tool/job/directory sites the answer name-drops in passing.
 * Mirrors the "drop non-competitors caught by extraction" step every
 * mention-mining workflow this codebase implements calls for (review sites,
 * analyst firms, category-hosting platforms — never a rival).
 * Matched case-insensitively against the exact rival name; deliberately not a
 * substring match, so a real company whose name happens to contain one of
 * these words is never swept up by mistake.
 */
const NON_COMPETITOR_NAMES = new Set([
  'chatgpt', 'gpt', 'openai', 'gemini', 'google gemini', 'claude', 'anthropic',
  'perplexity', 'copilot', 'microsoft copilot', 'bing', 'bing ai', 'grok',
  'meta ai', 'llama',
  'g2', 'g2.com', 'capterra', 'trustpilot', 'trustradius', 'getapp',
  'software advice', 'producthunt', 'product hunt',
  'indeed', 'linkedin', 'glassdoor', 'ziprecruiter',
  'reddit', 'quora', 'wikipedia', 'youtube',
  'google play', 'app store', 'apple app store', 'play store', 'appbrain', 'sensor tower', 'app annie',
]);

/** True when `name` is a platform/review-site/job-board an answer name-drops, never an actual competitor. */
function isNonCompetitorName(name: string): boolean {
  return NON_COMPETITOR_NAMES.has(name.trim().toLowerCase());
}

/** kebab-slug of a name/path-segment, so "Amazon Prime" and "amazon-prime" compare equal. */
function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * A legal name minus its entity-type suffix and punctuation — "Taladhwaja
 * Global Ventures (OPC) Pvt Ltd" and an AI answer's "...Private Limited"
 * both reduce to "taladhwajaglobalventures", so the two forms compare equal
 * even though neither string literally contains the other.
 */
function coreLegalName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\((opc|pvt|private)\)/gi, '')
    .replace(/\b(opc|pvt\.?|private|ltd\.?|limited|llc|inc\.?|corp\.?|co\.?|company)\b/gi, '')
    .replace(/[^a-z0-9]/g, '');
}

function normalizeForCompare(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Classic edit distance — small strings only, used for near-duplicate brand-name detection. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prevDiag = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prevDiag : 1 + Math.min(prevDiag, dp[j], dp[j - 1]);
      prevDiag = tmp;
    }
  }
  return dp[n];
}

/**
 * A short LLM-hallucinated misspelling of the client's own brand ("Fydo",
 * "Fayda", "Fahdu" for "Faydo") is not a competitor, it's the model
 * stumbling over its own name. Caught by edit distance rather than exact
 * match, since the exact-match `excluded` set only drops perfect spellings.
 */
function isSelfNameVariant(name: string, subjectName: string): boolean {
  const a = normalizeForCompare(name);
  const b = normalizeForCompare(subjectName);
  if (!a || !b || a === b) return a === b;
  if (Math.abs(a.length - b.length) > 2) return false;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen > 12) return false; // long names need an exact match, not fuzzy — avoids false positives
  return levenshtein(a, b) <= 2;
}

/** Answer text handed to the judge, capped so one long answer cannot blow the budget. */
const MAX_ANSWER_CHARS = 12_000;

/** Result of judging a whole run. */
export interface StancePassResult {
  judged: number;
  skipped: number;
  failed: number;
  costUsd: number;
  judgeModel: string;
}

/**
 * Per-rival absence/co-mention aggregate over one audit's stances
 * (discoverability-pipeline Stage 4 step 1). All counts are over answers in
 * which the rival was named as an `otherNamesSeen` entry.
 */
export interface CompetitorSignal {
  /** Rival name, first-seen casing. */
  name: string;
  /** Mentions where the client was `absent` in the same answer (strongest "beats us" signal). */
  absenceMentions: number;
  /** Mentions where the client was also present (co-considered). */
  coMentions: number;
  /** absenceMentions + coMentions. */
  totalMentions: number;
  /** Distinct surfaces/engines the rival was seen on (platform coverage). */
  distinctSurfaces: number;
  /** Distinct prompt dimensions the rival appeared under (prompt diversity). */
  distinctDimensions: number;
  /** Average 1-based position within `brandsNamed`, or null when never derivable. */
  avgPosition: number | null;
}

@Injectable()
export class AeoStanceService {
  private readonly logger = new Logger(AeoStanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: AeoLlmService,
    private readonly fetcher: FetcherService,
  ) {}

  /** Is the judge configured? Callers use this to report honestly, not to guess. */
  isAvailable(): boolean {
    return this.llm.isAvailable();
  }

  /**
   * Judge every observation of a measurement run and persist the verdicts.
   *
   * Idempotent: observations already judged for this audit are skipped, so a
   * re-run after a partial failure only fills the gaps.
   *
   * @param auditId Audit the stances belong to.
   * @param projectId Project the stances belong to — used only to route any
   *   newly-seen brand names into the {@link Competitor} candidate queue.
   * @param runId Measurement run whose observations get judged.
   * @param subject The client — name and domain.
   * @param competitors Named competitors to look for in the answer.
   * @param costCapUsd Stop and return early once this much has been spent.
   * @param surface Recorded on each row so stance rolls up per engine.
   * @throws ServiceUnavailableException when no API key is configured.
   */
  async judgeRun(
    auditId: string,
    projectId: string,
    runId: string,
    subject: { name: string; domain: string },
    competitors: string[],
    costCapUsd: number,
    surface?: string,
  ): Promise<StancePassResult> {
    if (!this.isAvailable()) {
      throw new ServiceUnavailableException(
        'No LLM provider configured — stance analysis unavailable. Set OPENROUTER_API_KEY ' +
          '(preferred) or ANTHROPIC_API_KEY. The counted metrics (mention rate, citation ' +
          'rate, share of voice) are unaffected — they never depended on a model.',
      );
    }

    const judgeModel = this.llm.modelName();
    const observations = await this.prisma.observation.findMany({
      where: { runId },
      orderBy: { createdAt: 'asc' },
    });

    const alreadyJudged = new Set(
      (
        await this.prisma.aeoStance.findMany({
          where: { auditId },
          select: { observationId: true },
        })
      ).map((r) => r.observationId),
    );

    // Prompt → dimension, resolved once so each judgement can be filed under
    // its category without a join per row.
    const dimensionByPrompt = await this.dimensionsForRun(runId);

    let judged = 0;
    let skipped = 0;
    let failed = 0;
    let costUsd = 0;
    const newNames = new Set<string>();

    for (const obs of observations) {
      if (alreadyJudged.has(obs.id)) {
        skipped++;
        continue;
      }
      if (costUsd >= costCapUsd) {
        this.logger.warn(
          `Stance pass stopped at the cost cap ($${costCapUsd}) after ${judged} judgements — ` +
            `${observations.length - judged - skipped - failed} observations left unjudged`,
        );
        break;
      }

      try {
        const result = await this.judgeOne(
          judgeModel,
          obs.prompt,
          obs.rawAnswer,
          subject,
          competitors,
        );
        costUsd += result.costUsd;

        await this.prisma.aeoStance.create({
          data: {
            auditId,
            observationId: obs.id,
            surface: surface ?? null,
            dimension: dimensionByPrompt.get(obs.prompt) ?? null,
            stance: result.verdict.stance,
            rankAmongBrands: result.verdict.rankAmongBrands,
            brandsNamed: JSON.stringify(result.verdict.brandsNamed),
            recommendedOver: JSON.stringify(result.verdict.recommendedOver),
            losesTo: JSON.stringify(result.verdict.losesTo),
            otherNamesSeen: JSON.stringify(result.verdict.otherNamesSeen),
            evidenceQuote: result.verdict.evidenceQuote,
            rationale: result.verdict.rationale,
            judgeModel,
            costUsd: result.costUsd,
          },
        });
        judged++;
        for (const name of result.verdict.otherNamesSeen) newNames.add(name);
      } catch (err) {
        failed++;
        this.logger.warn(`Stance judgement failed for observation ${obs.id}: ${(err as Error).message}`);
      }
    }

    this.logger.log(
      `Stance pass for audit ${auditId}: ${judged} judged, ${skipped} already done, ${failed} failed ` +
        `($${costUsd.toFixed(4)})`,
    );

    if (newNames.size > 0) {
      await this.captureCandidates(projectId, subject, competitors, [...newNames]);
    }

    return { judged, skipped, failed, costUsd: Number(costUsd.toFixed(6)), judgeModel };
  }

  /**
   * File brand names an AI surface mentioned that weren't already recorded
   * competitors, as `Competitor(status: 'candidate')` rows — never directly
   * as tracked competitors (see the provenance rule in the class docstring).
   * An operator confirms or rejects each one; nothing here is trusted until
   * they do.
   *
   * Best-effort: a write failure here must never fail the stance pass itself.
   */
  private async captureCandidates(
    projectId: string,
    subject: { name: string; domain: string },
    knownCompetitors: string[],
    names: string[],
  ): Promise<void> {
    try {
      const existing = await this.prisma.competitor.findMany({
        where: { projectId },
        select: { name: true },
      });
      const existingLower = new Set(existing.map((c) => c.name.toLowerCase()));
      const ownLegalNames = await this.ownLegalNames(projectId);
      const excluded = new Set(
        [subject.name, ...knownCompetitors, ...ownLegalNames].map((n) => n.toLowerCase()),
      );
      const catalog = await this.ownCatalogSlugs(subject.domain);
      const subjectWord = new RegExp(`(^|[^a-z0-9])${subject.name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
      const ownLegalCores = new Set(ownLegalNames.map(coreLegalName).filter(Boolean));

      for (const name of names) {
        const key = name.toLowerCase();
        if (existingLower.has(key) || excluded.has(key) || isNonCompetitorName(name)) continue;
        if (isSelfNameVariant(name, subject.name)) continue;
        if (catalog.has(slugify(name))) continue;
        // "Faydo Connect", "Faydo for Business" — a name that carries the
        // client's own brand as a whole word is a sub-product/line extension,
        // not a rival, even though it's not an exact match of the brand alone.
        if (name.toLowerCase() !== subject.name.toLowerCase() && subjectWord.test(name)) continue;
        if (ownLegalCores.has(coreLegalName(name))) continue;
        try {
          await this.prisma.competitor.create({
            data: { projectId, name, source: 'aeo-answer', status: 'candidate' },
          });
          existingLower.add(key);
        } catch (err) {
          // Unique [projectId, name] race with a concurrent writer — fine, skip it.
          this.logger.debug(`Candidate "${name}" not recorded for ${projectId}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      this.logger.warn(`Candidate capture failed for project ${projectId}: ${(err as Error).message}`);
    }
  }

  /**
   * The client's own operating company, as extracted into site context (§9's
   * `legalName`/`alternateName` facts) — an AI answer explaining who runs the
   * site ("Faydo is brought to you by Taladhwaja Global Ventures...") gets
   * its own operator named alongside it, which is not a competitor.
   */
  private async ownLegalNames(projectId: string): Promise<string[]> {
    try {
      const facts = await this.prisma.siteContextFact.findMany({
        where: { run: { projectId }, field: { in: ['legalName', 'alternateName'] } },
        select: { value: true },
      });
      return facts.map((f) => f.value);
    } catch {
      return [];
    }
  }

  /** Highest `<loc>`-listed sitemap files to read while hunting for a catalog. */
  private static readonly MAX_CATALOG_SITEMAP_FILES = 15;

  /**
   * A marketplace/reseller client's sitemap is its own product list — "Amazon
   * Prime", "Myntra", "Swiggy" as `/brand/<slug>` pages on a gift-card
   * discount site are the client's own catalog, not rivals, even though an AI
   * answer describing the client will naturally name them. Reads the site's
   * sitemap fresh (cheap, plain XML — no browser render) and returns every
   * last URL path segment, slugified, as the set of "things this site sells."
   * Best-effort and capped: a client with no real catalog (most sites) simply
   * gets an empty set back and every candidate is judged on the other checks.
   */
  private async ownCatalogSlugs(domain: string): Promise<Set<string>> {
    const slugs = new Set<string>();
    try {
      const origin = 'https://' + domain;
      const readXml = async (url: string): Promise<string[]> => {
        try {
          const res = await this.fetcher.fetch({ url, timeout: 15000 }, 'aeo-stance-catalog');
          if (res.status !== 200 || !res.body) return [];
          return [...res.body.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1]);
        } catch {
          return [];
        }
      };

      const robots = await readXml(origin + '/robots.txt').catch(() => []);
      // robots.txt isn't XML, so pull `Sitemap:` lines the same way `sitemapCandidates` does.
      const robotsBody = await this.fetcher
        .fetch({ url: origin + '/robots.txt', timeout: 15000 }, 'aeo-stance-catalog')
        .then((r) => (r.status === 200 ? r.body : ''))
        .catch(() => '');
      const fromRobots = [...robotsBody.matchAll(/^\s*Sitemap:\s*(\S+)/gim)].map((m) => m[1].trim());
      const entryPoints = fromRobots.length > 0 ? fromRobots : [origin + '/sitemap.xml', origin + '/sitemap-index.xml'];
      void robots;

      let top: string[] = [];
      for (const entry of entryPoints) {
        top = await readXml(entry);
        if (top.length > 0) break;
      }

      const isXml = (u: string) => /\.xml(\.gz)?$/i.test(u);
      const flat = top.filter((u) => !isXml(u));
      let frontier = top.filter(isXml);
      let filesRead = 0;
      while (frontier.length > 0 && filesRead < AeoStanceService.MAX_CATALOG_SITEMAP_FILES) {
        const child = frontier.shift()!;
        filesRead++;
        const entries = await readXml(child);
        flat.push(...entries.filter((u) => !isXml(u)));
        frontier.push(...entries.filter(isXml));
      }

      for (const u of flat) {
        if (!u.startsWith(origin)) continue;
        const path = u.slice(origin.length).split(/[?#]/)[0].replace(/\/$/, '');
        const lastSegment = path.split('/').filter(Boolean).pop();
        if (lastSegment) slugs.add(slugify(lastSegment));
      }
    } catch (err) {
      this.logger.debug(`Catalog lookup skipped for ${domain}: ${(err as Error).message}`);
    }
    return slugs;
  }

  /** Every stored stance for an audit, typed. */
  async list(auditId: string): Promise<StanceVerdict[]> {
    const rows = await this.prisma.aeoStance.findMany({
      where: { auditId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      observationId: row.observationId,
      surface: row.surface,
      dimension: this.asDimension(row.dimension),
      stance: this.asStance(row.stance),
      rankAmongBrands: row.rankAmongBrands,
      brandsNamed: this.parseArray(row.brandsNamed),
      recommendedOver: this.parseArray(row.recommendedOver),
      losesTo: this.parseArray(row.losesTo),
      otherNamesSeen: this.parseArray(row.otherNamesSeen),
      evidenceQuote: row.evidenceQuote,
      rationale: row.rationale,
    }));
  }

  /**
   * Absence/co-mention aggregation over stored stances (discoverability-pipeline
   * Stage 4 step 1). Pure read — no new extraction, no LLM call. Groups the
   * `otherNamesSeen` names (rivals an answer surfaced) and, for each, splits its
   * mentions by whether the *client* was `absent` in that same answer:
   *
   *  - **absence** signal = the rival was named while the client was absent (the
   *    rival owns an answer the client does not appear in — the strongest "beat
   *    us here" signal).
   *  - **co-mention** signal = the rival was named while the client was also
   *    present (both considered together).
   *
   * Also counts distinct surfaces (platform coverage) and dimensions (prompt
   * diversity), and averages the rival's 1-based position within `brandsNamed`
   * where derivable. Feeds Stage 4's weighted ranking.
   */
  async aggregateCompetitorSignals(auditId: string): Promise<CompetitorSignal[]> {
    const verdicts = await this.list(auditId);
    const acc = new Map<
      string,
      { display: string; absence: number; co: number; surfaces: Set<string>; dims: Set<string>; positions: number[] }
    >();
    for (const v of verdicts) {
      const clientAbsent = v.stance === 'absent';
      for (const rawName of v.otherNamesSeen) {
        const name = rawName.trim();
        if (!name || isNonCompetitorName(name)) continue;
        const key = name.toLowerCase();
        let bucket = acc.get(key);
        if (!bucket) {
          bucket = { display: name, absence: 0, co: 0, surfaces: new Set(), dims: new Set(), positions: [] };
          acc.set(key, bucket);
        }
        if (clientAbsent) bucket.absence++;
        else bucket.co++;
        if (v.surface) bucket.surfaces.add(v.surface);
        if (v.dimension) bucket.dims.add(v.dimension);
        const idx = v.brandsNamed.findIndex((n) => n.trim().toLowerCase() === key);
        if (idx >= 0) bucket.positions.push(idx + 1);
      }
    }
    return [...acc.values()].map((b) => ({
      name: b.display,
      absenceMentions: b.absence,
      coMentions: b.co,
      totalMentions: b.absence + b.co,
      distinctSurfaces: b.surfaces.size,
      distinctDimensions: b.dims.size,
      avgPosition: b.positions.length ? b.positions.reduce((s, n) => s + n, 0) / b.positions.length : null,
    }));
  }

  // ─── The judge ─────────────────────────────────────────────────────────

  /**
   * Judge one answer.
   *
   * The model is told to read the answer as the buyer would and report what the
   * answer *does*, not what it thinks of the client. It must quote the answer
   * verbatim for its call, which keeps the judgement checkable by a human.
   */
  private async judgeOne(
    model: string,
    prompt: string,
    rawAnswer: string,
    subject: { name: string; domain: string },
    competitors: string[],
  ): Promise<{ verdict: StanceVerdict; costUsd: number }> {
    void model; // the provider picks the model; the caller records which one ran
    const answer = rawAnswer.slice(0, MAX_ANSWER_CHARS);

    const result = await this.llm.json(
      {
        purpose: 'stance judgement',
        maxTokens: 1200,
        system:
          'You read one AI assistant answer and report how it positioned a specific company. ' +
          'You are an impartial analyst: report what the answer does, not what you think of the company.\n' +
          'stance — pick exactly one:\n' +
          '  "recommended-primary": the answer leads with this company, or names it as the top/first choice.\n' +
          '  "recommended-alternative": named as one credible option among several, without being led with.\n' +
          '  "mentioned-neutral": named, but with no endorsement either way.\n' +
          '  "mentioned-negative": named with a caveat, warning, or as the weaker option.\n' +
          '  "absent": not named at all.\n' +
          'Rules:\n' +
          '- brandsNamed: every company the answer names, in the order the answer names them. ' +
          'Include the subject if named. Do not include the subject if it is absent.\n' +
          "- rankAmongBrands: the subject's 1-based position in brandsNamed, or null when absent.\n" +
          '- recommendedOver: competitors the answer places BELOW the subject. Only when the answer ' +
          'actually makes that comparison — an empty array is the correct answer otherwise.\n' +
          '- losesTo: competitors the answer places ABOVE the subject. Same rule.\n' +
          '- otherNamesSeen: every company in brandsNamed that is NOT in the "Known competitors" list ' +
          'and is not the subject itself — i.e. brands new to us. Company names only, never generic ' +
          'terms, categories, or the subject\'s own name.\n' +
          '- evidenceQuote: up to 280 characters copied VERBATIM from the answer that justifies the ' +
          'stance. null only when the subject is absent.\n' +
          '- rationale: one short sentence.\n' +
          '- Never infer beyond the answer text. If the answer does not compare two companies, do not rank them.\n' +
          'Respond with ONLY JSON: {"stance":string,"brandsNamed":string[],"rankAmongBrands":number|null,' +
          '"recommendedOver":string[],"losesTo":string[],"otherNamesSeen":string[],"evidenceQuote":string|null,' +
          '"rationale":string}',
        user:
          'Subject company: "' + subject.name + '" (' + subject.domain + ')\n' +
          'Known competitors: ' + (competitors.length ? competitors.join(', ') : 'none recorded') + '\n\n' +
          'The buyer asked:\n' + prompt + '\n\n' +
          'The assistant answered:\n' + answer,
      },
      (raw) => this.validate(raw, competitors),
    );

    return { verdict: result.data, costUsd: result.costUsd };
  }

  /**
   * Coerce the judge's JSON into a {@link StanceVerdict}.
   *
   * Competitor names are intersected with the recorded list so the judge cannot
   * invent a rival, and an absent subject is forced to a null rank — the two
   * ways a sloppy judgement could otherwise mislead the report.
   */
  private validate(raw: unknown, competitors: string[]): StanceVerdict {
    const obj = (raw ?? {}) as Record<string, unknown>;
    const known = new Map(competitors.map((c) => [c.toLowerCase(), c]));

    const strArr = (v: unknown, cap: number): string[] =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean).slice(0, cap)
        : [];

    /** Keep only names that match a recorded competitor. */
    const knownOnly = (v: unknown): string[] => {
      const out: string[] = [];
      for (const name of strArr(v, 20)) {
        const match = known.get(name.toLowerCase());
        if (match && !out.includes(match)) out.push(match);
      }
      return out;
    };

    const stance = this.asStance(typeof obj.stance === 'string' ? obj.stance : 'absent');
    const absent = stance === 'absent';

    const rankRaw = obj.rankAmongBrands;
    const rank =
      !absent && typeof rankRaw === 'number' && Number.isFinite(rankRaw) && rankRaw >= 1
        ? Math.floor(rankRaw)
        : null;

    const quote = typeof obj.evidenceQuote === 'string' ? obj.evidenceQuote.trim().slice(0, 280) : '';

    // Deliberately NOT run through knownOnly() — this is the one field meant
    // to surface names the judge saw that we did NOT already know about.
    // Still sanity-filtered (length, not the subject itself, not a dupe of a
    // known competitor by looser casing) since raw LLM output can otherwise
    // hand a "candidate" queue garbage.
    const otherNamesSeen = strArr(obj.otherNamesSeen, 10)
      .filter((n) => n.length >= 2 && n.length <= 60)
      .filter((n) => !known.has(n.toLowerCase()))
      .filter((n, i, arr) => arr.findIndex((x) => x.toLowerCase() === n.toLowerCase()) === i);

    return {
      observationId: '', // filled by the caller
      surface: null, // filled by the caller
      dimension: null, // filled by the caller
      stance,
      rankAmongBrands: rank,
      brandsNamed: strArr(obj.brandsNamed, 20),
      recommendedOver: absent ? [] : knownOnly(obj.recommendedOver),
      losesTo: knownOnly(obj.losesTo),
      otherNamesSeen: absent ? [] : otherNamesSeen,
      evidenceQuote: absent || !quote ? null : quote,
      rationale: typeof obj.rationale === 'string' ? obj.rationale.trim().slice(0, 400) : null,
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  /**
   * Map each prompt of a run back to the matrix category it came from, so a
   * stance can be filed under its dimension without joining per row.
   */
  private async dimensionsForRun(runId: string): Promise<Map<string, string>> {
    const run = await this.prisma.measurementRun.findUnique({
      where: { id: runId },
      select: { querySetId: true },
    });
    if (!run) return new Map();
    const items = await this.prisma.querySetItem.findMany({
      where: { querySetId: run.querySetId },
      select: { prompt: true, dimension: true },
    });
    const map = new Map<string, string>();
    for (const item of items) {
      if (item.dimension) map.set(item.prompt, item.dimension);
    }
    return map;
  }

  private asStance(raw: string): Stance {
    return (STANCES as readonly string[]).includes(raw) ? (raw as Stance) : 'absent';
  }

  private asDimension(raw: string | null): PromptDimension | null {
    return raw && (PROMPT_DIMENSIONS as readonly string[]).includes(raw) ? (raw as PromptDimension) : null;
  }

  private parseArray(raw: string): string[] {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

}
