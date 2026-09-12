'use client';

/**
 * agentRuns — what each agent can actually be told to do, and when it cannot,
 * exactly what is missing.
 *
 * The Agents Feed used to show the backend's suggested next step as dead text.
 * This turns those into real calls. Every run here is deterministic by design:
 * `useLlm` is never set, and live answer surfaces stay behind SWARM_ALLOW_LIVE
 * server-side, so nothing spends money unless the operator configured it.
 *
 * An agent with no entry, or one returning a `blocked` reason, keeps the
 * read-only treatment rather than offering a button that would 4xx.
 *
 * @module app/v2/_lib/agentRuns
 */

import {
  createMeasurementRun,
  executeMeasurementRun,
  generateFindings,
  generatePersonas,
  runAuthorityScan,
  runCouncil,
  runMonitoringCheck,
} from '@/lib/terminal-api';
import type { Integration } from '@/types/terminal';

/** one control on a run form — kept deliberately small */
export type RunField =
  | { kind: 'number'; name: string; label: string; def: number; min: number; max: number }
  | { kind: 'select'; name: string; label: string; def: string; options: Array<{ value: string; label: string }> }
  | { kind: 'text'; name: string; label: string; def?: string; placeholder?: string };

export type RunValues = Record<string, string | number>;

export interface RunSpec {
  /** button copy — a verb, naming exactly what happens */
  label: string;
  /** one line under the form: what this does, and what it costs */
  note: string;
  fields: RunField[];
  run: (projectId: string, v: RunValues) => Promise<void>;
}

/** why an agent cannot be run right now, in the operator's language */
export interface RunBlocked {
  blocked: string;
}

export type RunOption = RunSpec | RunBlocked | null;

export const isBlocked = (r: RunOption): r is RunBlocked => r !== null && 'blocked' in r;
export const isRunnable = (r: RunOption): r is RunSpec => r !== null && !('blocked' in r);

/** context the resolver needs to decide availability */
export interface RunContext {
  integrations: Integration[];
  /** query sets for the active project — null while still unknown */
  querySets: Array<{ id: string; label: string | null; persona: string; items: unknown[] }> | null;
}

const num = (v: string | number | undefined, fallback: number) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const str = (v: string | number | undefined) => (v === undefined ? '' : String(v)).trim();

/** measurement surfaces the server will actually accept right now */
function surfaceOptions(integrations: Integration[]) {
  const on = (key: string) => integrations.some((i) => i.key === key && i.connected);
  const opts: Array<{ value: string; label: string }> = [];
  if (on('anthropic')) opts.push({ value: 'claude', label: 'Claude' });
  if (on('perplexity')) opts.push({ value: 'perplexity', label: 'Perplexity' });
  // the mock surface is gated server-side by MEASUREMENT_ALLOW_MOCK; offering
  // it lets a project be exercised end to end without a key or any spend
  opts.push({ value: 'mock', label: 'Sample data (no spend)' });
  return opts;
}

/**
 * Resolve the run for one agent key. Returns null when the agent has no write
 * path worth surfacing yet.
 */
export function runFor(agentKey: string, ctx: RunContext): RunOption {
  switch (agentKey) {
    case 'personas':
      return {
        label: 'Generate personas',
        note: 'Seeded and reproducible — no model spend.',
        fields: [{ kind: 'number', name: 'count', label: 'How many', def: 10, min: 1, max: 25 }],
        run: async (projectId, v) => {
          await generatePersonas(projectId, { count: num(v.count, 10) });
        },
      };

    case 'articles':
      return {
        label: 'Generate findings',
        note: 'Derives content gaps from the audit and entity data already on file.',
        fields: [{ kind: 'number', name: 'limit', label: 'Max findings', def: 10, min: 1, max: 50 }],
        run: async (projectId, v) => {
          await generateFindings(projectId, { limit: num(v.limit, 10) });
        },
      };

    case 'authority':
      return {
        label: 'Run discovery scan',
        note: 'Finds listicle and mention targets for the category.',
        fields: [
          {
            kind: 'text',
            name: 'category',
            label: 'Category',
            placeholder: 'defaults to the project category',
          },
        ],
        run: async (projectId, v) => {
          const category = str(v.category);
          await runAuthorityScan(projectId, category ? { category } : {});
        },
      };

    case 'council':
      return {
        label: 'Run council',
        note: 'Role agents debate the artefacts on file; a synthesiser ranks the result.',
        fields: [
          { kind: 'number', name: 'rounds', label: 'Rounds', def: 1, min: 1, max: 3 },
          {
            kind: 'text',
            name: 'question',
            label: 'Question',
            placeholder: 'defaults to the standing brief',
          },
        ],
        run: async (projectId, v) => {
          const question = str(v.question);
          await runCouncil(projectId, {
            rounds: num(v.rounds, 1),
            ...(question ? { question } : {}),
          });
        },
      };

    case 'monitoring':
      return {
        label: 'Run check now',
        note: 'Compares current signals against the baseline and records regressions.',
        fields: [],
        run: async (projectId) => {
          await runMonitoringCheck(projectId);
        },
      };

    case 'aeo': {
      if (ctx.querySets === null) return { blocked: 'Checking for a query set…' };
      const usable = ctx.querySets.filter((q) => q.items.length > 0);
      if (usable.length === 0) {
        return {
          blocked:
            'Measurement needs a query set with at least one prompt. Build one from the buyer queries on the flywheel first.',
        };
      }
      const surfaces = surfaceOptions(ctx.integrations);
      return {
        label: 'Run measurement',
        note: 'Runs the set against the chosen surface and scores every answer for mentions and citations.',
        fields: [
          {
            kind: 'select',
            name: 'querySetId',
            label: 'Query set',
            def: usable[0].id,
            options: usable.map((q) => ({
              value: q.id,
              label: `${q.label ?? q.persona} · ${q.items.length} prompt${q.items.length === 1 ? '' : 's'}`,
            })),
          },
          {
            kind: 'select',
            name: 'surface',
            label: 'Surface',
            def: surfaces[0].value,
            options: surfaces,
          },
        ],
        run: async (projectId, v) => {
          const created = await createMeasurementRun(projectId, {
            querySetId: str(v.querySetId),
            surface: str(v.surface),
          });
          await executeMeasurementRun(projectId, created.id);
        },
      };
    }

    case 'rivals':
      // has its own competitive panel
      return null;

    case 'attribution':
      // has its own panel — a form to install and a report to read
      return null;

    case 'seo':
      // the audit belongs to the Audits card, which already holds the target
      // URL and the findings view to show afterwards
      return { blocked: 'Run the audit from the Audits card — it has the results view.' };

    case 'serp':
      return { blocked: 'SERP capture needs a tracker with queries, and licensed SERP data.' };

    case 'journeys':
      return { blocked: 'Planning a journey needs an active persona to plan for.' };

    case 'mentions':
      return { blocked: 'Mention tracking needs at least one outreach target on file.' };

    default:
      return null;
  }
}
