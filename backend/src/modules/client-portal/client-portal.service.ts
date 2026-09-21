/**
 * Client Portal Service — what an authenticated client-type User can read
 * and write. Every method takes the caller's own `clientId` (off the JWT,
 * never a client-supplied value) and scopes every query to it — the one
 * class of bug that matters here, per client-portal.md's own security
 * section: no endpoint trusts a client-supplied account/project id.
 *
 * Read-only except: posting a message. No live engine access — this reads
 * already-computed rows (Report, Gap, Project), same "published snapshot,
 * not the live tables" instinct as the full client-portal.md plan, just
 * without that plan's separate publish-gate machinery.
 *
 * @module client-portal.service
 */

import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ReportLifecycleService } from '../reporting/report-lifecycle.service';
import { ContentWorkspaceService } from '../content-workspace/content-workspace.service';
import { WritingStyleService } from '../writing-style/writing-style.service';
import { QuerySetService } from '../query-set/query-set.service';
import { PromptRequestsService } from '../prompt-requests/prompt-requests.service';
import { ContentRequestsService } from '../content-requests/content-requests.service';
import type { CreatePromptRequestInput } from '../prompt-requests/prompt-requests.types';
import type { CreateContentRequestInput } from '../content-requests/content-requests.types';
import type { PortalProjectDto, PortalReportSummaryDto, PortalMessageDto } from './client-portal.types';
// Type-only — erased at compile time, no module/DI coupling to `clients`.
import type { OnboardingWizardState } from '../clients/clients.types';

@Injectable()
export class ClientPortalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reportLifecycle: ReportLifecycleService,
    private readonly contentWorkspace: ContentWorkspaceService,
    private readonly writingStyle: WritingStyleService,
    private readonly querySet: QuerySetService,
    private readonly promptRequests: PromptRequestsService,
    private readonly contentRequests: ContentRequestsService,
  ) {}

  /** Every client-project route re-checks ownership here — never trusts a client-supplied projectId. */
  private async assertOwnsProject(clientId: string, projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { clientId: true } });
    if (!project || project.clientId !== clientId) {
      throw new ForbiddenException('That project does not belong to this client');
    }
  }

  // ─── C2 onboarding wizard (docs/analysis/client-portal.md §2/§11/§16/§17,
  // corrected order — the report and the rest of the portal are reachable
  // right after details are confirmed; GSC/GA4 connect is prompted AFTER,
  // not before. See `../../../web/src/app/(client)/client/projects/[projectId]/layout.tsx`
  // for the gate that reads this state; it blocks only `not-started`/
  // `confirming-details`, never `connecting-gsc`/`connecting-ga4`.) ────────
  //
  // State lives on `Project.onboardingWizardState` (C1's column,
  // `not-started | confirming-details | connecting-gsc | connecting-ga4 |
  // done | waived`) and is checked here for every transition, never on the
  // client — a client calling these out of order gets 409, not a state jump.
  // Deliberately scoped to `projectId`, never the caller's own userId (§17):
  // a colleague accepting a seat invite on an already-onboarded project reads
  // `done`/`waived` immediately, same as the person who actually did the
  // connecting.

  /** Read the current wizard gate state for one of this client's projects. */
  async getOnboardingWizardState(clientId: string, projectId: string): Promise<{ projectId: string; state: OnboardingWizardState }> {
    await this.assertOwnsProject(clientId, projectId);
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { onboardingWizardState: true } });
    return { projectId, state: project.onboardingWizardState as OnboardingWizardState };
  }

  /**
   * Step (a): confirm/edit details. Does not itself write business-profile
   * fields — the client edits those through the existing
   * `PUT`/`POST .../business-profile[/confirm]` endpoints (§12, reused
   * as-is) — this only advances the gate once a confirmed profile exists, so
   * "confirming details" cannot be skipped by simply calling this route.
   *
   * The transition target is `connecting-gsc` (unchanged from C1's state
   * machine), but — this is the corrected part — the project-level gate no
   * longer blocks on that state, so the client can see their Day-1 report
   * and use the rest of the portal immediately after this call returns.
   */
  async confirmDetailsStep(clientId: string, projectId: string): Promise<{ projectId: string; state: OnboardingWizardState }> {
    await this.assertOwnsProject(clientId, projectId);
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { onboardingWizardState: true } });
    const state = project.onboardingWizardState as OnboardingWizardState;

    if (state === 'done' || state === 'waived') {
      throw new ConflictException(`Onboarding is already ${state} for this project — there is nothing to confirm.`);
    }
    if (state !== 'not-started' && state !== 'confirming-details') {
      throw new ConflictException(`Cannot confirm details from state "${state}" — that step has already been passed.`);
    }

    const confirmedProfile = await this.prisma.businessProfile.findFirst({
      where: { projectId, confirmedAt: { not: null } },
      orderBy: { version: 'desc' },
    });
    if (!confirmedProfile) {
      throw new ConflictException(
        'No confirmed business profile on file yet. Review and confirm your details (POST .../business-profile/confirm) before continuing.',
      );
    }

    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: { onboardingWizardState: 'connecting-gsc' satisfies OnboardingWizardState },
    });
    return { projectId, state: updated.onboardingWizardState as OnboardingWizardState };
  }

  /** Step (b): mark Google Search Console connected, gated on a real, live project-mapped connection actually existing. */
  async connectGscDoneStep(clientId: string, projectId: string): Promise<{ projectId: string; state: OnboardingWizardState }> {
    return this.advanceGoogleStep(clientId, projectId, 'connecting-gsc', 'search-console', 'connecting-ga4', 'Google Search Console');
  }

  /** Step (c): mark Google Analytics 4 connected, gated the same way; the terminal transition into `done`. */
  async connectGa4DoneStep(clientId: string, projectId: string): Promise<{ projectId: string; state: OnboardingWizardState }> {
    return this.advanceGoogleStep(clientId, projectId, 'connecting-ga4', 'analytics', 'done', 'Google Analytics');
  }

  private async advanceGoogleStep(
    clientId: string,
    projectId: string,
    requiredState: OnboardingWizardState,
    service: 'search-console' | 'analytics',
    nextState: OnboardingWizardState,
    serviceLabel: string,
  ): Promise<{ projectId: string; state: OnboardingWizardState }> {
    await this.assertOwnsProject(clientId, projectId);
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { onboardingWizardState: true } });
    const state = project.onboardingWizardState as OnboardingWizardState;

    if (state === 'done' || state === 'waived') {
      throw new ConflictException(`Onboarding is already ${state} for this project.`);
    }
    if (state !== requiredState) {
      throw new ConflictException(`Cannot connect ${serviceLabel} from state "${state}" — expected "${requiredState}".`);
    }

    // A live, project-mapped resource must actually exist — not merely "the
    // client clicked next". Reuses the same `GoogleProjectResource` row the
    // existing connections UI reads/writes; no new OAuth mechanics here, just
    // the gating check.
    const mapped = await this.prisma.googleProjectResource.findUnique({
      where: { projectId_service: { projectId, service } },
    });
    if (!mapped) {
      throw new ConflictException(
        `${serviceLabel} is not connected yet for this project. Complete the OAuth connection (POST .../integrations/google/authorize, then map a resource) before continuing.`,
      );
    }

    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: { onboardingWizardState: nextState satisfies OnboardingWizardState },
    });
    return { projectId, state: updated.onboardingWizardState as OnboardingWizardState };
  }

  /**
   * P08 §13.5 client-safe content list. Only pieces with an explicitly
   * shared revision appear at all (§13.5 exit gate) — an unshared draft is
   * never included, not merely hidden by the UI.
   */
  async listContent(clientId: string, projectId: string) {
    await this.assertOwnsProject(clientId, projectId);
    const items = await this.contentWorkspace.listClientSafeItems(projectId);
    return { items };
  }

  /**
   * P08 §13.5 client-safe content detail. Defaults to the explicitly shared
   * revision, never the latest internal draft; 404s (rather than a filtered
   * 200) when nothing has ever been shared, so "no content" and "not shared
   * with you" are never confused by the response shape.
   */
  async getContent(clientId: string, projectId: string, assetId: string) {
    await this.assertOwnsProject(clientId, projectId);
    const item = await this.contentWorkspace.getClientSafeItem(projectId, assetId);
    if (!item) throw new NotFoundException(`Content ${assetId} not found or not shared with this client`);
    return item;
  }

  /**
   * P09 §13.8 client-safe writing-style read: the ACTIVE CONFIRMED style
   * only, never a draft — client-edit rights are a §22 D04 decision with no
   * evidence a prior phase settled it, so this stays read-only.
   */
  async getWritingStyle(clientId: string, projectId: string) {
    await this.assertOwnsProject(clientId, projectId);
    return this.writingStyle.getActive(projectId);
  }

  // ─── C4 §13/§20 — prompt visibility + add/delete request queue ──────

  /**
   * The real, active query set — read-only (§3, §13). Deliberately reuses
   * `QuerySetService.list(projectId, 'active')` rather than a client-safe
   * projection: unlike content, there is no draft/internal vocabulary to
   * strip here — an active set IS the measured prompt list, and §13 is
   * explicit that the client sees "the real list of active prompts... not a
   * summary or count."
   */
  async listPrompts(clientId: string, projectId: string) {
    await this.assertOwnsProject(clientId, projectId);
    const sets = await this.querySet.list(projectId, 'active');
    return { sets };
  }

  async listPromptRequests(clientId: string, projectId: string) {
    await this.assertOwnsProject(clientId, projectId);
    const requests = await this.promptRequests.listForClient(clientId, projectId);
    return { requests };
  }

  async createPromptRequest(
    clientId: string,
    projectId: string,
    userId: string,
    input: Omit<CreatePromptRequestInput, 'projectId' | 'clientId' | 'requestedByUserId'>,
  ) {
    await this.assertOwnsProject(clientId, projectId);
    return this.promptRequests.create({ ...input, projectId, clientId, requestedByUserId: userId });
  }

  // ─── C4 §14/§22 — structured "request new content" form ─────────────

  async listContentRequests(clientId: string, projectId: string) {
    await this.assertOwnsProject(clientId, projectId);
    const requests = await this.contentRequests.listForClient(clientId, projectId);
    return { requests };
  }

  async createContentRequest(
    clientId: string,
    projectId: string,
    userId: string,
    input: Omit<CreateContentRequestInput, 'projectId' | 'clientId' | 'requestedByUserId'>,
  ) {
    await this.assertOwnsProject(clientId, projectId);
    return this.contentRequests.create({ ...input, projectId, clientId, requestedByUserId: userId });
  }

  async listProjects(clientId: string): Promise<{ projects: PortalProjectDto[] }> {
    const rows = await this.prisma.project.findMany({ where: { clientId }, orderBy: { createdAt: 'desc' } });

    // G05 — "latest" means the latest **released** report. A draft or an
    // unreleased revision is not the client's to see, and showing its score
    // here would leak exactly what the editorial gate holds back. The score
    // must come from the frozen released `ReportRevision` snapshot, not the
    // mutable `Report.scoreTotal` columns: an operator editing a draft
    // revision after release must not change the client's project card, and
    // this is the same snapshot discipline `listReleasedForClient` applies
    // to the report list/detail.
    const projectIds = rows.map((p) => p.id);
    const releasedReports = projectIds.length
      ? await this.prisma.report.findMany({
          where: {
            projectId: { in: projectIds },
            status: 'released',
            releasedRevision: { not: null },
            releasedAt: { not: null },
          },
          orderBy: { releasedAt: 'desc' },
          select: { id: true, projectId: true, releasedRevision: true, releasedAt: true },
        })
      : [];
    const latestReleasedPerProject = new Map<string, (typeof releasedReports)[number]>();
    for (const report of releasedReports) {
      // Ordered by releasedAt desc, so the first seen per project is the latest.
      if (!latestReleasedPerProject.has(report.projectId)) {
        latestReleasedPerProject.set(report.projectId, report);
      }
    }
    // One batched read for every released revision referenced above; each
    // revision is fetched at its exact released number and status — a
    // disagreeing row (status ≠ released) serves nothing, matching the
    // lifecycle service's "serve nothing rather than a guess" rule.
    const revisions = await this.prisma.reportRevision.findMany({
      where: {
        OR: [...latestReleasedPerProject.values()].map((report) => ({
          reportId: report.id,
          revision: report.releasedRevision ?? -1,
          status: 'released',
        })),
      },
      select: { reportId: true, revision: true, snapshot: true },
    });
    const latestScoreByProject = new Map<string, { scoreTotal: number | null; scoreBand: string | null; releasedAt: Date | null }>();
    for (const report of latestReleasedPerProject.values()) {
      const revision = revisions.find((r) => r.reportId === report.id && r.revision === report.releasedRevision);
      if (!revision) continue;
      try {
        const snapshot = JSON.parse(revision.snapshot) as { scoreTotal?: number; scoreBand?: string };
        latestScoreByProject.set(report.projectId, {
          scoreTotal: typeof snapshot.scoreTotal === 'number' ? snapshot.scoreTotal : null,
          scoreBand: typeof snapshot.scoreBand === 'string' ? snapshot.scoreBand : null,
          releasedAt: report.releasedAt,
        });
      } catch {
        // Unreadable snapshot: leave the card without a score rather than
        // falling back to mutable columns or a fabricated value.
      }
    }

    const projects = await Promise.all(
      rows.map(async (p) => {
        const released = latestScoreByProject.get(p.id);
        return {
          id: p.id,
          name: p.name,
          domain: p.domain,
          onboardingStatus: p.onboardingStatus,
          onboardingStep: p.onboardingStep,
          latestScore: released?.scoreTotal ?? null,
          latestBand: released?.scoreBand ?? null,
          lastAuditAt: released?.releasedAt?.toISOString() ?? null,
        };
      }),
    );
    return { projects };
  }

  /**
   * The client's released reports.
   *
   * G05 — delegated to `ReportLifecycleService`, which filters on
   * `status = "released"` **and** a non-null `releasedRevision` and reads each
   * report's title/score from its frozen revision. Before G05 this listed every
   * report row for the client's projects, drafts included (§5.10 step 4).
   */
  async listReports(clientId: string): Promise<{ reports: PortalReportSummaryDto[] }> {
    const { reports } = await this.reportLifecycle.listReleasedForClient(clientId);
    return {
      reports: reports.map((r) => ({
        id: r.reportId,
        projectId: r.projectId,
        slug: r.slug,
        title: r.title,
        scoreTotal: r.scoreTotal,
        scoreBand: r.scoreBand,
        createdAt: r.contentUpdatedAt,
        revision: r.revision,
        releasedAt: r.releasedAt,
      })),
    };
  }

  /**
   * The full report by slug — release-gated, not merely ownership-checked.
   *
   * G05 changed what "the client's report" means: this serves the report's
   * frozen released revision, and a report that is a draft, in review,
   * approved-but-unreleased or withdrawn is answered with the same 404 as one
   * that does not exist. `Report.visibility` is deliberately **not** the gate
   * here — it governs the unauthenticated HTML link, and a released report is
   * routinely private.
   */
  async getReport(clientId: string, slug: string) {
    return this.reportLifecycle.getReleasedForClient(clientId, slug);
  }

  async listMessages(clientId: string): Promise<{ messages: PortalMessageDto[] }> {
    const rows = await this.prisma.clientMessage.findMany({ where: { clientId }, orderBy: { createdAt: 'asc' } });
    return {
      messages: rows.map((r) => ({
        id: r.id,
        projectId: r.projectId,
        authorType: r.authorType as PortalMessageDto['authorType'],
        body: r.body,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  /** Posted by the authenticated CLIENT — authorType is always "client" here, never trusted from the caller. */
  async postMessage(clientId: string, authorUserId: string, dto: { projectId?: string; body: string }): Promise<PortalMessageDto> {
    if (dto.projectId) {
      const owns = await this.prisma.project.findUnique({ where: { id: dto.projectId }, select: { clientId: true } });
      if (!owns || owns.clientId !== clientId) {
        throw new ForbiddenException('That project does not belong to this client');
      }
    }
    const row = await this.prisma.clientMessage.create({
      data: { clientId, projectId: dto.projectId ?? null, authorUserId, authorType: 'client', body: dto.body },
    });
    return {
      id: row.id,
      projectId: row.projectId,
      authorType: 'client',
      body: row.body,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
