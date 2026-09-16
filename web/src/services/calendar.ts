import { api } from '@/lib/api';
import type { ReportRow, WorkRow } from './operations';

/**
 * Portfolio calendar adapter (G14) — design_plan.md screen OP13 "Team
 * calendar": *"Work due dates, reviews, releases, automated runs, timezone,
 * drag-to-reschedule alternative form"*, support "N G06/G07; three schedule
 * readers can seed a limited run-only view".
 *
 * Why this file exists rather than reusing `services/operations.ts`:
 * `PortfolioListQueryDto` whitelists exactly `page` and `pageSize`, and the API
 * runs `forbidNonWhitelisted: true`, so a `limit=` or `cursor=` query string is
 * a 400 rather than an ignored field. The responses are
 * `{ items, page, pageSize, total }` — the same object `operations.ts` types as
 * `{ items, nextCursor, total }`. Rather than change the shape out from under
 * screens that already import it, this module reads the real contract and
 * reuses `operations.ts`'s row types, which are correct.
 *
 * Everything here is **server-filtered and server-paginated** for the fields
 * the DTO actually declares — status, category, discipline, priority, assignee,
 * client, project, overdue and free-text search — so the calendar's type/state
 * filters never disagree with the Today screen about scope.
 *
 * One honest limitation, stated here because it shapes the screen: neither
 * endpoint accepts a **date range**. `WorkQueryDto` has no `from`/`to` and
 * `ReportsQueryDto` has none either, so a window such as "next 30 days" is a
 * *local* filter applied to the rows a page actually loaded. The screen says so
 * and shows how many rows are loaded against the server's total, rather than
 * implying the window was applied portfolio-wide.
 */

/** The real page envelope for the `/operations/*` list endpoints. */
export interface PortfolioPage<T> {
  items: T[];
  /** 1-based. */
  page: number;
  pageSize: number;
  /** Total matching records under the same filters — never a client count. */
  total: number;
}

/** The filters `WorkQueryDto` accepts. Values outside the enums are rejected. */
export interface PortfolioWorkQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: string;
  category?: string;
  discipline?: string;
  priority?: string;
  assigneeId?: string;
  clientId?: string;
  projectId?: string;
  /** Past `dueAt` and not verified/cancelled — finished work is never late. */
  overdue?: boolean;
  /** Lets the object be spread straight into `api.get`'s query record. */
  [key: string]: string | number | boolean | undefined;
}

export interface PortfolioReportQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: string;
  visibility?: string;
  clientId?: string;
  projectId?: string;
  [key: string]: string | number | boolean | undefined;
}

/**
 * Work items across the portfolio, server-filtered and paginated.
 *
 * `overdue` is the server's own definition (past due and not verified or
 * cancelled), so the overdue band of the calendar never disagrees with the
 * Today screen about what is late.
 */
export async function listPortfolioWork(
  query: PortfolioWorkQuery,
  options?: { signal?: AbortSignal },
): Promise<PortfolioPage<WorkRow>> {
  return api.get<PortfolioPage<WorkRow>>('/operations/work', { ...options, query });
}

export async function listPortfolioReports(
  query: PortfolioReportQuery,
  options?: { signal?: AbortSignal },
): Promise<PortfolioPage<ReportRow>> {
  return api.get<PortfolioPage<ReportRow>>('/operations/reports', { ...options, query });
}

/**
 * One dated entry on the calendar, normalized from either source.
 *
 * `date` is the ISO instant the entry hangs on. For work items that is `dueAt`,
 * which the server resolved against the project's engagement timezone when it
 * was written; for reports it is `releasedAt`. The calendar never re-derives a
 * date from a status or a period — an entry with no date is not on the
 * calendar at all, and is reported as undated instead of being guessed at.
 */
export interface CalendarEntry {
  id: string;
  kind: 'work' | 'release';
  /** ISO 8601. */
  date: string;
  title: string;
  status: string;
  category?: string;
  discipline?: string;
  priority?: string;
  projectId: string;
  projectName: string;
  clientId: string | null;
  clientName: string | null;
  /** Work only — true when the server flagged it overdue. */
  overdue?: boolean;
  /** Raw source row, so a caller can act on it without a second lookup. */
  work?: WorkRow;
  report?: ReportRow;
}

export function toCalendarEntries(
  work: readonly WorkRow[],
  reports: readonly ReportRow[],
): CalendarEntry[] {
  const entries: CalendarEntry[] = [];

  for (const row of work) {
    if (!row.dueAt) continue;
    entries.push({
      id: `work:${row.id}`,
      kind: 'work',
      date: row.dueAt,
      title: row.title,
      status: row.status,
      category: row.category,
      discipline: row.discipline,
      priority: row.priority,
      projectId: row.projectId,
      projectName: row.projectName,
      clientId: row.clientId,
      clientName: row.clientName,
      overdue: row.overdue,
      work: row,
    });
  }

  for (const row of reports) {
    if (!row.releasedAt) continue;
    entries.push({
      id: `release:${row.id}`,
      kind: 'release',
      date: row.releasedAt,
      title: row.title,
      status: row.status,
      projectId: row.projectId,
      projectName: row.projectName,
      clientId: row.clientId,
      clientName: row.clientName,
      report: row,
    });
  }

  return entries.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

/** Work rows in the portfolio that carry no due date, so they are off-calendar. */
export function undatedWorkCount(work: readonly WorkRow[]): number {
  return work.filter((row) => !row.dueAt).length;
}

/**
 * The presets the window control offers, as day offsets from today.
 *
 * `null` to means "no upper bound". These are presets, not defaults: the screen
 * opens on "everything" so no work is hidden by a window the reader did not
 * choose.
 */
export const CALENDAR_RANGE_PRESETS = [
  { key: 'overdue-30', label: 'Overdue and next 30 days', fromOffset: null, toOffset: 30 },
  { key: 'next-90', label: 'Next 90 days', fromOffset: 0, toOffset: 90 },
  { key: 'all', label: 'Everything on file', fromOffset: null, toOffset: null },
] as const;

export type CalendarRangePresetKey = (typeof CALENDAR_RANGE_PRESETS)[number]['key'];

/** The `from`/`to` instants for a preset, computed against the viewer's clock. */
export function rangeForPreset(
  key: CalendarRangePresetKey,
  now: Date = new Date(),
): { from?: string; to?: string } {
  const preset = CALENDAR_RANGE_PRESETS.find((candidate) => candidate.key === key);
  if (!preset || preset.key === 'all') return {};
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const result: { from?: string; to?: string } = {};
  if (preset.fromOffset !== null) {
    const from = new Date(startOfToday);
    from.setDate(from.getDate() + preset.fromOffset);
    result.from = from.toISOString();
  }
  if (preset.toOffset !== null) {
    const to = new Date(startOfToday);
    to.setDate(to.getDate() + preset.toOffset);
    to.setHours(23, 59, 59, 999);
    result.to = to.toISOString();
  }
  return result;
}
