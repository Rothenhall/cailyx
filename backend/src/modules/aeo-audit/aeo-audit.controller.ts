/**
 * AEO Audit Controller — REST API for answer-engine visibility audits.
 *
 * Routes (all under `/api/projects/:projectId/aeo`):
 *   POST /context                    run the staged website-understanding pipeline → SiteContext
 *   GET  /context                    latest stored context
 *   GET  /context/runs               staff: staged-run history for this project
 *   GET  /context/runs/:runId        staff: one run's stage/budget/page/fact detail
 *   POST /context/runs/:runId/resume staff: resume a paused/failed run
 *   POST /matrix                     generate the categorised prompt matrix
 *   GET  /matrix/:querySetId         read a matrix, grouped by category
 *   GET  /budget                     what a run would cost, before starting it
 *   POST /audits                     start an audit (no spend)
 *   POST /audits/full                start + run every stage to a verdict
 *   POST /audits/:auditId/resume     continue a stopped/failed audit
 *   POST /audits/:auditId/stance     judge (or finish judging) the run
 *   POST /audits/:auditId/narrative  regenerate the customer-facing narrative framing
 *   GET  /audits                     list audits
 *   GET  /audits/:auditId            one audit + its stored verdict
 *   GET  /audits/:auditId/verdict    recompute the verdict from stored rows
 *
 * @module aeo-audit.controller
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AeoAuditService } from './aeo-audit.service';
import { AeoContextService, SiteContextRunPausedException } from './aeo-context.service';
import { AeoMatrixService } from './aeo-matrix.service';
import { AeoVisibilityService } from './aeo-visibility.service';
import {
  BudgetQueryDto,
  BuildContextDto,
  GenerateMatrixDto,
  MatrixQueryDto,
  ResumeContextRunDto,
  RunAuditDto,
  StancePassResponse,
  VisibilityQueryDto,
} from './dto/aeo-audit.dto';
import { AEO_SURFACES, TIER_SIZES } from './aeo-audit.types';
import type { AeoSurface, MatrixTier, PromptDimension } from './aeo-audit.types';
import { PipelineQueueService } from '../jobs/pipeline-queue.service';

@ApiTags('AEO Audit')
@ApiBearerAuth()
@Controller('projects/:projectId/aeo')
export class AeoAuditController {
  constructor(
    private readonly audits: AeoAuditService,
    private readonly context: AeoContextService,
    private readonly matrix: AeoMatrixService,
    private readonly visibility: AeoVisibilityService,
    private readonly pipelineQueue: PipelineQueueService,
  ) {}

  // ─── AI visibility (merged read composition, §8) ───────────────────────
  // Staff-scoped like the rest of this controller — no `@ClientPortal()` here,
  // so these reads are not reachable by a client account (RolesGuard is
  // default-deny). The client-facing AEO numbers remain the aggregate-only
  // portal results read.

  @Get('visibility/summary')
  @ApiOperation({
    summary: 'AI visibility — summary view',
    description:
      'Score/mention-rate where valid, how many questions were checked, locations, dates and a plain-' +
      'English status. Composed from the audit/verdict this module already computes — no new measurement. ' +
      'Failed/gated surfaces are named in `disclosedFailures`, never dropped to flatter the visible rate.',
  })
  @ApiResponse({ status: 200, description: 'Summary' })
  @ApiResponse({ status: 404, description: 'No completed measurement for this project, or the given audit does not belong to it' })
  async visibilitySummary(@Param('projectId') projectId: string, @Query() query: VisibilityQueryDto) {
    return this.visibility.summary(projectId, query.auditId);
  }

  @Get('visibility/questions')
  @ApiOperation({
    summary: 'AI visibility — customer questions view',
    description:
      'Question-level aggregate, grouped by business topic, with stable pagination and the current/' +
      'selected question-set version stamped on every page. A question with zero observations reports ' +
      '`checked: false` ("Not checked"), never a fabricated zero-appearance count.',
  })
  @ApiResponse({ status: 200, description: 'One page of customer questions' })
  @ApiResponse({ status: 404, description: 'No completed measurement for this project, or the given audit does not belong to it' })
  async visibilityQuestions(@Param('projectId') projectId: string, @Query() query: VisibilityQueryDto) {
    return this.visibility.questions(projectId, {
      auditId: query.auditId,
      topic: query.topic as PromptDimension | undefined,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Get('visibility/history')
  @ApiOperation({
    summary: 'AI visibility — history view',
    description:
      'Comparable measurements across every completed/failed audit, oldest-to-newest internally but ' +
      'returned newest-first. Each entry that used a different question-set version than the one before ' +
      'it carries `comparabilityBreak: true` and a stated reason — history is never silently flattened ' +
      'into one continuous chart across a wording/topic/market change.',
  })
  @ApiResponse({ status: 200, description: 'History entries, newest first' })
  async visibilityHistory(@Param('projectId') projectId: string) {
    return { history: await this.visibility.history(projectId) };
  }

  // ─── Context ───────────────────────────────────────────────────────────

  @Post('context')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary: 'Build site context',
    description:
      "Crawls the client's own site (homepage + sitemap-guided service/solution/pricing pages) and " +
      'extracts what they sell, who buys it, the pains buyers arrive with and the outcomes they want. ' +
      'With ANTHROPIC_API_KEY set, one constrained LLM pass organises the fetched text; without it the ' +
      'deterministic extraction stands and `extraction` reports "deterministic".\n\n' +
      'Queued on the background pipeline, not run inline — a full build (plus any Phase 2 stages requested) ' +
      'can take 20-30+ minutes, which a background worker can self-resume through as many times as it takes ' +
      'without ever blocking this request. Returns immediately with a jobId; poll GET context/jobs/:jobId.',
  })
  @ApiBody({ type: BuildContextDto })
  @ApiResponse({ status: 202, description: '{ jobId, projectId, status: "queued" }' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async buildContext(@Param('projectId') projectId: string, @Body() body: BuildContextDto) {
    const opts = {
      maxPages: body.maxPages,
      refine: body.refine,
      maxRequests: body.maxRequests,
      maxChars: body.maxChars,
      maxElapsedMs: body.maxElapsedMs,
      externalEnrichment: body.externalEnrichment,
      socialDiscovery: body.socialDiscovery,
      gapResearch: body.gapResearch,
    };
    const { jobId } = await this.pipelineQueue.enqueue(
      'site-context-build',
      { projectId, opts },
      { attempts: 2, backoff: { type: 'exponential', delay: 30000 } },
    );
    return { jobId, projectId, status: 'queued' };
  }

  @Get('context/jobs/:jobId')
  @ApiOperation({ summary: 'Get the status of a queued site-context build job' })
  @ApiResponse({ status: 200, description: 'Job status — waiting/active/completed/failed, with result or error' })
  @ApiResponse({ status: 404, description: 'Job does not exist, or belongs to a different project' })
  async getContextJob(@Param('projectId') projectId: string, @Param('jobId') jobId: string) {
    const status = await this.pipelineQueue.getStatus(jobId);
    if (status.status === 'not_found' || (status.projectId && status.projectId !== projectId)) {
      throw new NotFoundException(`Site-context build job ${jobId} not found for project ${projectId}`);
    }
    return status;
  }

  @Get('context')
  @ApiOperation({ summary: 'Latest stored site context' })
  @ApiResponse({ status: 200, description: 'The most recent context for this project' })
  @ApiResponse({ status: 404, description: 'No context has been built yet' })
  async latestContext(@Param('projectId') projectId: string) {
    const ctx = await this.context.latest(projectId);
    if (!ctx) {
      throw new NotFoundException('No site context for project ' + projectId + ' — POST /context first');
    }
    return ctx;
  }

  @Get('context/runs')
  @ApiOperation({ summary: 'Staged context-pipeline run history (staff)', description: 'Every stage, budget and coverage-plan snapshot for past runs, newest first.' })
  @ApiResponse({ status: 200, description: 'Run summaries' })
  async listContextRuns(@Param('projectId') projectId: string) {
    return { projectId, runs: await this.context.listRuns(projectId) };
  }

  @Get('context/runs/:runId')
  @ApiOperation({ summary: 'One staged context run in detail (staff)', description: 'Stage/budget/coverage state plus every discovered page and extracted fact, for inspecting or diagnosing a run.' })
  @ApiResponse({ status: 200, description: 'Run detail' })
  @ApiResponse({ status: 404, description: 'Run not found' })
  async getContextRun(@Param('projectId') projectId: string, @Param('runId') runId: string) {
    const detail = await this.context.getRun(runId);
    if (detail.run.projectId !== projectId) {
      throw new NotFoundException('Site context run not found: ' + runId + ' for project ' + projectId);
    }
    return detail;
  }

  @Post('context/runs/:runId/resume')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary: 'Resume a paused/failed staged context run (staff)',
    description:
      'Continues from the last completed stage. Pages already fetched are not re-fetched; pages whose ' +
      'extraction already succeeded are not re-extracted; only pending/failed pages (under the retry cap) are retried.',
  })
  @ApiBody({ type: ResumeContextRunDto })
  @ApiResponse({
    status: 200,
    description:
      'A completed run returns the stored context; a run that hit its elapsed-time budget again returns ' +
      '`{ paused: true, runId, reachedStage, message }` — resume it once more. Both are 200.',
  })
  @ApiResponse({ status: 404, description: 'Run not found' })
  async resumeContextRun(@Param('projectId') projectId: string, @Param('runId') runId: string, @Body() body: ResumeContextRunDto) {
    const existing = await this.context.getRun(runId);
    if (existing.run.projectId !== projectId) {
      throw new NotFoundException('Site context run not found: ' + runId + ' for project ' + projectId);
    }
    try {
      return await this.context.resume(runId, { maxElapsedMs: body.maxElapsedMs });
    } catch (err) {
      if (err instanceof SiteContextRunPausedException) {
        return { paused: true, runId: err.runId, reachedStage: err.reachedStage, message: err.message };
      }
      throw err;
    }
  }

  // ─── Matrix ────────────────────────────────────────────────────────────

  @Post('matrix')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary: 'Generate the prompt matrix',
    description:
      'Builds the prompts a real buyer would type, across ten categories (service discovery, ' +
      'category best-of, competitor alternatives, head-to-head, brand direct, problem framed, ' +
      'buying criteria, objection/trust, job-to-be-done, geo/vertical). Every prompt is stored with ' +
      'its category and full metadata (register, branded/unbranded, which service or competitor it ' +
      'targets) so results can be sliced and the matrix curated afterwards. Stored as a versioned ' +
      'QuerySet, so it inherits immutability-on-activation and client export.',
  })
  @ApiBody({ type: GenerateMatrixDto })
  @ApiResponse({ status: 201, description: 'Matrix generated, grouped by category' })
  @ApiResponse({ status: 400, description: 'Site context is too thin to generate any prompt' })
  @ApiResponse({ status: 404, description: 'Project or context not found' })
  async generateMatrix(@Param('projectId') projectId: string, @Body() body: GenerateMatrixDto) {
    const ctx = body.contextId
      ? await this.context.get(body.contextId)
      : await this.context.latest(projectId);
    if (!ctx) {
      throw new NotFoundException('No site context for project ' + projectId + ' — POST /context first');
    }
    return this.matrix.generate(projectId, ctx, {
      tier: body.tier as MatrixTier | undefined,
      refine: body.refine,
      activate: body.activate,
    });
  }

  @Get('matrix/:querySetId')
  @ApiOperation({
    summary: 'Read a matrix, grouped by category',
    description: 'Pass ?dimension= to return a single category — the curation view.',
  })
  @ApiResponse({ status: 200, description: 'Matrix with per-category counts and prompts' })
  @ApiResponse({ status: 404, description: 'Matrix not found' })
  async getMatrix(@Param('querySetId') querySetId: string, @Query() query: MatrixQueryDto) {
    const summary = await this.matrix.summary(querySetId);
    if (!query.dimension) return summary;
    const dimension = query.dimension as PromptDimension;
    return { ...summary, byDimension: summary.byDimension.filter((d) => d.dimension === dimension) };
  }

  // ─── Audits ────────────────────────────────────────────────────────────

  @Get('budget')
  @ApiOperation({
    summary: 'What this run would cost',
    description:
      'Pre-flight credit estimate for a configuration the operator has not run yet. The run-time guard ' +
      'already refuses a run that cannot finish inside the allowance, but by then the choice is made — ' +
      'this is the same arithmetic while the tier is still being picked. Browser surfaces report 0 ' +
      'credits (a subscription pays for them, not the meter). When the balance cannot be read, ' +
      '`remaining` and `fits` are null with the reason stated — an unknown balance is neither ' +
      'sufficient nor insufficient.',
  })
  @ApiResponse({ status: 200, description: 'The estimate' })
  async budget(@Param('projectId') projectId: string, @Query() query: BudgetQueryDto) {
    const surfaces = (query.surfaces ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is AeoSurface => (AEO_SURFACES as readonly string[]).includes(s));
    const tier = (query.tier ?? 'trial') as MatrixTier;
    return this.audits.estimateBudget(
      surfaces,
      TIER_SIZES[tier] ?? 0,
      query.runCount ?? 5,
      query.markets ?? 1,
    );
  }

  @Post('audits')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Start an audit',
    description: 'Creates the audit row only — no scraping and no spend. Drive it with /resume.',
  })
  @ApiBody({ type: RunAuditDto })
  @ApiResponse({ status: 201, description: 'Audit created in pending state' })
  @ApiResponse({ status: 400, description: 'runCount < 5 (n>=5, no exceptions)' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async startAudit(@Param('projectId') projectId: string, @Body() body: RunAuditDto) {
    return this.audits.start(projectId, this.toInput(body));
  }

  @Post('audits/full')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 300000, limit: 3 } })
  @ApiOperation({
    summary: 'Start and queue a complete audit',
    description:
      'context → matrix → measurement (n>=5 per prompt) → stance → verdict, queued on the background ' +
      'pipeline. Returns immediately with the audit in `pending` status — poll GET /audits/:auditId ' +
      '(or list audits) for `status`/`stage` until `completed`. ' +
      'Long-running: a 100-prompt matrix at n=5 is 500 prompts on the surface.',
  })
  @ApiBody({ type: RunAuditDto })
  @ApiResponse({ status: 201, description: 'Audit queued (status: pending)' })
  @ApiResponse({ status: 400, description: 'runCount < 5, or context too thin for a matrix' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 503, description: 'Surface disabled or session missing (chatgpt-browser)' })
  async runFull(@Param('projectId') projectId: string, @Body() body: RunAuditDto) {
    return this.audits.runFullAsync(projectId, this.toInput(body));
  }

  @Post('audits/:auditId/resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resume an audit',
    description:
      'Continues from the last completed stage — a failed measurement resumes on the stored context ' +
      'and matrix rather than re-scraping and re-generating.',
  })
  @ApiBody({ type: RunAuditDto, required: false })
  @ApiResponse({ status: 200, description: 'Audit advanced to completion' })
  @ApiResponse({ status: 404, description: 'Audit not found' })
  @ApiResponse({ status: 409, description: 'Audit is already completed' })
  async resumeAudit(@Param('auditId') auditId: string, @Body() body: RunAuditDto) {
    return this.audits.resume(auditId, this.toInput(body ?? {}));
  }

  @Post('audits/:auditId/stance')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary: 'Judge competitive stance',
    description:
      'Reads every answer in the run and records how the client was positioned: led the answer, ' +
      'named as one option among others, named with a caveat, or absent — plus which competitors ' +
      'the answer placed above or below them, with a verbatim quote. Idempotent: already-judged ' +
      'observations are skipped, so a partial pass can be finished. ' +
      'These are LLM judgements, stored apart from the counted rates and never merged into them.',
  })
  @ApiResponse({ status: 200, description: 'Stance pass result', type: StancePassResponse })
  @ApiResponse({ status: 400, description: 'Audit has not measured anything yet' })
  @ApiResponse({ status: 404, description: 'Audit not found' })
  @ApiResponse({ status: 503, description: 'ANTHROPIC_API_KEY not configured' })
  async judgeStance(
    @Param('projectId') projectId: string,
    @Param('auditId') auditId: string,
  ): Promise<StancePassResponse> {
    return this.audits.judgeStance(projectId, auditId);
  }

  @Post('audits/:auditId/narrative')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary: 'Regenerate customer-facing narrative framing',
    description:
      'Rewrites the deterministic headlines into a persuasive-but-grounded customer narrative — ' +
      'a first audit is framed around the seriousness of real findings, a repeat audit is framed ' +
      'around the genuine delta since the prior comparable audit. Runs automatically once per ' +
      'completed audit; this endpoint lets it be regenerated on demand. Degrades to no narrative ' +
      '(headlines remain the fallback) when no LLM provider is configured or validation fails.',
  })
  @ApiResponse({ status: 200, description: 'Narrative block, or null if generation was skipped/failed' })
  @ApiResponse({ status: 400, description: 'Audit has not completed yet' })
  @ApiResponse({ status: 404, description: 'Audit not found' })
  async regenerateNarrative(@Param('auditId') auditId: string) {
    return this.audits.regenerateNarrative(auditId);
  }

  @Get('audits')
  @ApiOperation({ summary: 'List audits for a project (newest first)' })
  @ApiResponse({ status: 200, description: 'Audit list' })
  async listAudits(@Param('projectId') projectId: string) {
    return { audits: await this.audits.list(projectId) };
  }

  @Get('audits/:auditId')
  @ApiOperation({ summary: 'One audit with its stored verdict' })
  @ApiResponse({ status: 200, description: 'Audit + verdict (verdict is null until completion)' })
  @ApiResponse({ status: 404, description: 'Audit not found' })
  async getAudit(@Param('auditId') auditId: string) {
    return this.audits.get(auditId);
  }

  @Get('audits/:auditId/verdict')
  @ApiOperation({
    summary: 'Recompute the verdict',
    description:
      'Rebuilds the report from stored observations and stances. Counted metrics (mention rate, ' +
      'citation rate, share of voice) and judged stance are returned in separate blocks — the ' +
      'counted block is the only one whose numbers may be quoted as rates.',
  })
  @ApiResponse({ status: 200, description: 'Verdict' })
  @ApiResponse({ status: 400, description: 'Audit has not measured anything yet' })
  @ApiResponse({ status: 404, description: 'Audit not found' })
  async getVerdict(@Param('auditId') auditId: string) {
    return this.audits.verdict(auditId);
  }

  /** Narrow the validated DTO into the service input type. */
  private toInput(body: RunAuditDto) {
    return {
      surface: body.surface as AeoSurface | undefined,
      surfaces: body.surfaces as AeoSurface[] | undefined,
      tier: body.tier as MatrixTier | undefined,
      runCount: body.runCount,
      geo: body.geo,
      markets: body.markets,
      reuseContext: body.reuseContext,
      skipStance: body.skipStance,
      skipRefine: body.skipRefine,
      refreshMatrix: body.refreshMatrix,
    };
  }
}
