/**
 * Agents Service — builds the dashboard Agents Feed for a project.
 *
 * One aggregate read across the platform's models; each agent card's status
 * line reflects real artefacts (audit findings, link recs, gap rows, journeys,
 * personas, council rankings, mention targets, SERP snapshots, alerts).
 * Read-only; no module coupling beyond PrismaService.
 *
 * @module agents.service
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import type { AgentCard, AgentsResponse, AgentStatus } from './agents.types';

@Injectable()
export class AgentsService {
  constructor(private readonly prisma: PrismaService) {}

  async forProject(projectId: string): Promise<AgentsResponse> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + projectId);

    const [
      audit,
      linkGraph,
      gapAnalysis,
      measurementRun,
      entityAudit,
      findingsCount,
      pageAnalysisCount,
      authorityScan,
      journeys,
      campaigns,
      personas,
      councilSession,
      mentionTargets,
      serpTrackers,
      serpSnapshot,
      alerts,
    ] = await Promise.all([
      this.prisma.technicalAudit.findFirst({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        include: { findings: true },
      }),
      this.prisma.linkGraph.findFirst({ where: { projectId, status: 'complete' }, orderBy: { createdAt: 'desc' } }),
      this.prisma.gapAnalysis.findFirst({ where: { projectId } }),
      this.prisma.measurementRun.findFirst({ where: { projectId, status: 'completed' }, orderBy: { createdAt: 'desc' } }),
      this.prisma.entityAudit.findFirst({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        include: { entities: { include: { schemaChecks: true } } },
      }),
      this.prisma.finding.count({ where: { projectId } }),
      this.prisma.pageAnalysis.count({ where: { projectId } }),
      this.prisma.authorityScan.findFirst({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        include: { candidates: { select: { status: true } } },
      }),
      this.prisma.journey.findMany({ where: { projectId }, select: { status: true, mentionedSteps: true, executedSteps: true, plannedAt: true } }),
      this.prisma.journeyCampaign.count({ where: { projectId } }),
      this.prisma.persona.findMany({ where: { projectId }, select: { status: true, updatedAt: true } }),
      this.prisma.councilSession.findFirst({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        include: { rankings: { select: { interventionKey: true } } },
      }),
      this.prisma.mentionTarget.findMany({ where: { projectId }, select: { status: true, createdAt: true } }),
      this.prisma.serpTracker.findMany({ where: { projectId }, select: { id: true, queries: { select: { id: true } } } }),
      this.prisma.serpSnapshot.findFirst({
        where: { tracker: { projectId } },
        orderBy: { capturedAt: 'desc' },
        select: { capturedAt: true, queriesRun: true, status: true },
      }),
      this.prisma.alert.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 10, select: { createdAt: true, kind: true, severity: true } }),
    ]);

    const cards: AgentCard[] = [];

    // ── SEO Agent ────────────────────────────────────────────
    {
      const fails = (audit?.findings ?? []).filter((f) => f.status === 'fail').length;
      const warns = (audit?.findings ?? []).filter((f) => f.status === 'warn').length;
      const recs = linkGraph?.recommendationCount ?? 0;
      const orphans = linkGraph?.orphanCount ?? 0;
      const total = fails + recs;
      const status: AgentStatus = fails > 0 ? 'attention' : total > 0 ? 'ready' : 'idle';
      cards.push({
        key: 'seo',
        name: 'SEO Agent',
        category: 'seo',
        status,
        headline:
          total > 0
            ? `${total} recommendation${total === 1 ? '' : 's'} ready`
            : audit
              ? 'Site is clean — no on-page blockers'
              : 'Run a technical audit to get started',
        count: total,
        metric: audit ? `${fails} fail · ${warns} warn · ${recs} link fixes${orphans ? ` · ${orphans} orphan${orphans === 1 ? '' : 's'}` : ''}` : null,
        activity: [
          audit ? `Last technical audit: ${fails} failing, ${warns} warning check(s).` : 'No technical audit yet.',
          linkGraph ? `Internal-link graph: ${linkGraph.pagesCrawled} pages, ${recs} link recommendation(s), ${orphans} orphan(s).` : 'No internal-link analysis yet.',
        ],
        lastActivityAt: audit?.createdAt.toISOString() ?? linkGraph?.createdAt.toISOString() ?? null,
        href: `/projects/${projectId}/technical-audit`,
        cta: audit ? 'Review' : 'Run audit',
      });
    }

    // ── GEO Agent (AI visibility) ────────────────────────────
    {
      const gaps = gapAnalysis
        ? await this.prisma.gap.count({
            where: { gapAnalysisId: gapAnalysis.id, status: 'open', dimension: { in: ['visibility', 'narrative', 'web-mentions'] } },
          })
        : 0;
      const obs = measurementRun
        ? await this.prisma.observation.findMany({ where: { runId: measurementRun.id }, select: { mentioned: true, cited: true } })
        : [];
      const mentionRate = obs.length ? obs.filter((o) => o.mentioned).length / obs.length : null;
      const schemaFails = (entityAudit?.entities ?? []).flatMap((e) => e.schemaChecks).filter((c) => c.status === 'fail').length;
      const status: AgentStatus = gaps > 0 || schemaFails > 0 ? 'attention' : obs.length ? 'ready' : 'idle';
      cards.push({
        key: 'geo',
        name: 'GEO Agent',
        category: 'geo',
        status,
        headline:
          gaps > 0
            ? `${gaps} citation gap${gaps === 1 ? '' : 's'} detected`
            : obs.length
              ? `Mention rate ${Math.round((mentionRate ?? 0) * 100)}% across AI answers`
              : 'Measure AI visibility to get started',
        count: gaps,
        metric: obs.length ? `${obs.length} observations${schemaFails ? ` · ${schemaFails} schema fail${schemaFails === 1 ? '' : 's'}` : ''}` : null,
        activity: [
          measurementRun ? `Last measurement run: ${obs.length} observations, mention rate ${Math.round((mentionRate ?? 0) * 100)}%.` : 'No measurement run yet.',
          gapAnalysis ? `${gaps} open visibility/narrative gap(s).` : 'No gap analysis yet.',
          entityAudit ? `Entity audit: ${schemaFails} failing schema check(s).` : 'No entity audit yet.',
        ],
        lastActivityAt: measurementRun?.createdAt.toISOString() ?? entityAudit?.createdAt.toISOString() ?? null,
        href: `/projects/${projectId}/measurement`,
        cta: measurementRun ? 'Review gaps' : 'Measure',
      });
    }

    // ── Articles Agent (content) ─────────────────────────────
    {
      const total = findingsCount;
      cards.push({
        key: 'articles',
        name: 'Articles Agent',
        category: 'content',
        status: total > 0 ? 'ready' : 'idle',
        headline: total > 0 ? `${total} topic${total === 1 ? '' : 's'} ready` : 'Generate findings to seed content topics',
        count: total,
        metric: pageAnalysisCount > 0 ? `${pageAnalysisCount} page(s) analysed` : null,
        activity: [
          total > 0 ? `${total} finding(s) with what/why/fix copy generated.` : 'No findings generated yet.',
          pageAnalysisCount > 0 ? `${pageAnalysisCount} page(s) scored for extractability.` : 'No page analyses yet.',
        ],
        lastActivityAt: null,
        href: `/projects/${projectId}/findings`,
        cta: total > 0 ? 'Open' : 'Generate',
      });
    }

    // ── Authority Agent ─────────────────────────────────────
    {
      const cand = authorityScan?.candidates ?? [];
      const fresh = cand.filter((c) => c.status === 'new').length;
      cards.push({
        key: 'authority',
        name: 'Authority Agent',
        category: 'authority',
        status: fresh > 0 ? 'ready' : 'idle',
        headline: fresh > 0 ? `${fresh} opportunit${fresh === 1 ? 'y' : 'ies'} ready` : 'Run a discovery scan to find mention targets',
        count: fresh,
        metric: authorityScan ? `${cand.length} candidate(s) · ${cand.filter((c) => c.status === 'promoted').length} promoted` : null,
        activity: [
          authorityScan
            ? `Last scan (${authorityScan.method}): ${cand.length} candidate(s), ${fresh} not yet triaged.`
            : 'No authority discovery scan yet.',
        ],
        lastActivityAt: authorityScan?.createdAt.toISOString() ?? null,
        href: `/projects/${projectId}/authority`,
        cta: authorityScan ? 'Triage' : 'Discover',
      });
    }

    // ── Journey Agent ───────────────────────────────────────
    {
      const done = journeys.filter((j) => j.status === 'completed' || j.status === 'partial').length;
      const mentioned = journeys.reduce((a, j) => a + j.mentionedSteps, 0);
      const executed = journeys.reduce((a, j) => a + j.executedSteps, 0);
      cards.push({
        key: 'journeys',
        name: 'Journey Agent',
        category: 'journeys',
        status: done > 0 ? 'ready' : journeys.length > 0 ? 'running' : 'idle',
        headline:
          done > 0
            ? `${done} buyer journey${done === 1 ? '' : 's'} mapped`
            : journeys.length > 0
              ? `${journeys.length} journey(s) planned — not run`
              : 'Plan your first branching buyer journey',
        count: done,
        metric: executed > 0 ? `${mentioned}/${executed} steps mention you · ${campaigns} campaign(s)` : campaigns > 0 ? `${campaigns} campaign(s)` : null,
        activity: [
          journeys.length > 0 ? `${journeys.length} journey(s), ${done} executed across ${campaigns} campaign(s).` : 'No journeys planned yet.',
          executed > 0 ? `Brand mentioned in ${mentioned} of ${executed} simulated search steps.` : '',
        ].filter(Boolean),
        lastActivityAt: journeys.map((j) => j.plannedAt).sort().reverse()[0]?.toISOString() ?? null,
        href: `/projects/${projectId}/journeys`,
        cta: journeys.length > 0 ? 'Open' : 'Plan',
      });
    }

    // ── Persona Agent ───────────────────────────────────────
    {
      const active = personas.filter((p) => p.status === 'active').length;
      cards.push({
        key: 'personas',
        name: 'Persona Agent',
        category: 'personas',
        status: active > 0 ? 'ready' : personas.length > 0 ? 'attention' : 'idle',
        headline:
          active > 0
            ? `${active} persona${active === 1 ? '' : 's'} active`
            : personas.length > 0
              ? `${personas.length} persona(s) drafted — activate to use`
              : 'Generate synthetic buyer personas',
        count: active || personas.length,
        metric: personas.length ? `${personas.length} total` : null,
        activity: [
          personas.length > 0 ? `${personas.length} persona(s): ${active} active, ${personas.length - active} draft/archived.` : 'No personas generated yet.',
        ],
        lastActivityAt: personas.map((p) => p.updatedAt).sort().reverse()[0]?.toISOString() ?? null,
        href: `/projects/${projectId}/personas`,
        cta: personas.length > 0 ? 'Manage' : 'Generate',
      });
    }

    // ── Council Agent ───────────────────────────────────────
    {
      const ranks = councilSession?.rankings.length ?? 0;
      cards.push({
        key: 'council',
        name: 'Council Agent',
        category: 'council',
        status: ranks > 0 ? 'ready' : 'idle',
        headline: ranks > 0 ? `${ranks} intervention${ranks === 1 ? '' : 's'} ranked` : 'Run the council to prioritise interventions',
        count: ranks,
        metric: councilSession ? `${councilSession.rounds} round(s)` : null,
        activity: [
          councilSession
            ? `Last debate: ${ranks} intervention(s) ranked${ranks > 0 ? `, top = ${councilSession.rankings[0]?.interventionKey}` : ''}.`
            : 'No council session yet.',
        ],
        lastActivityAt: councilSession?.createdAt.toISOString() ?? null,
        href: `/projects/${projectId}/council`,
        cta: councilSession ? 'Open' : 'Run',
      });
    }

    // ── Mentions Agent ──────────────────────────────────────
    {
      const fresh = mentionTargets.filter((t) => t.status === 'new' || t.status === 'contacted').length;
      const placed = mentionTargets.filter((t) => t.status === 'placed').length;
      cards.push({
        key: 'mentions',
        name: 'Mentions Agent',
        category: 'mentions',
        status: fresh > 0 ? 'ready' : placed > 0 ? 'ready' : 'idle',
        headline:
          fresh > 0
            ? `${fresh} outreach target${fresh === 1 ? '' : 's'} in flight`
            : placed > 0
              ? `${placed} mention${placed === 1 ? '' : 's'} placed`
              : 'Add mention targets to track outreach',
        count: fresh || placed,
        metric: mentionTargets.length ? `${mentionTargets.length} target(s)` : null,
        activity: [
          mentionTargets.length > 0 ? `${mentionTargets.length} target(s): ${fresh} active, ${placed} placed.` : 'No mention targets yet.',
        ],
        lastActivityAt: mentionTargets.map((t) => t.createdAt).sort().reverse()[0]?.toISOString() ?? null,
        href: `/projects/${projectId}/mentions`,
        cta: mentionTargets.length > 0 ? 'Open' : 'Add targets',
      });
    }

    // ── SERP Agent ──────────────────────────────────────────
    {
      const queryCount = serpTrackers.reduce((a, t) => a + t.queries.length, 0);
      cards.push({
        key: 'serp',
        name: 'SERP Agent',
        category: 'serp',
        status: serpSnapshot ? 'ready' : serpTrackers.length ? 'attention' : 'idle',
        headline:
          serpSnapshot
            ? `${queryCount} quer${queryCount === 1 ? 'y' : 'ies'} tracked`
            : serpTrackers.length
              ? `${queryCount} quer${queryCount === 1 ? 'y' : 'ies'} — capture a snapshot`
              : 'Track SERP rankings & AI Overviews',
        count: queryCount,
        metric: serpSnapshot ? `last snapshot ${serpSnapshot.status}, ${serpSnapshot.queriesRun} run` : null,
        activity: [
          serpTrackers.length ? `${serpTrackers.length} tracker(s), ${queryCount} keyword(s).` : 'No SERP trackers yet.',
          serpSnapshot ? `Last snapshot: ${serpSnapshot.queriesRun} queries (${serpSnapshot.status}).` : 'No snapshot captured.',
        ],
        lastActivityAt: serpSnapshot?.capturedAt.toISOString() ?? null,
        href: `/projects/${projectId}/serp`,
        cta: serpTrackers.length ? 'Capture' : 'Add tracker',
      });
    }

    // ── Monitoring Agent ────────────────────────────────────
    {
      const critical = alerts.filter((a) => a.severity === 'critical').length;
      cards.push({
        key: 'monitoring',
        name: 'Monitoring Agent',
        category: 'monitoring',
        status: alerts.length ? 'attention' : 'ready',
        headline: alerts.length ? `${alerts.length} alert${alerts.length === 1 ? '' : 's'}${critical ? ` (${critical} critical)` : ''}` : 'No regressions detected',
        count: alerts.length,
        metric: alerts.length ? alerts.slice(0, 3).map((a) => a.kind).join(', ') : null,
        activity: [
          alerts.length ? `Recent: ${alerts.slice(0, 3).map((a) => `${a.kind} (${a.severity})`).join('; ')}.` : 'Watching score + mention-rate deltas.',
        ],
        lastActivityAt: alerts[0]?.createdAt.toISOString() ?? null,
        href: `/projects/${projectId}/monitoring`,
        cta: alerts.length ? 'Review' : 'Open',
      });
    }

    const needAttention = cards.filter((c) => c.status === 'attention' || c.status === 'blocked').length;
    const ready = cards.filter((c) => c.status === 'ready').length;
    const idle = cards.filter((c) => c.status === 'idle').length;
    return { projectId, agents: cards, summary: { total: cards.length, needAttention, ready, idle } };
  }
}
