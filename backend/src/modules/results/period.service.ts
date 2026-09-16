/**
 * PeriodService — G13's reporting windows.
 *
 * The single rule this service exists to enforce: **a window that was stored
 * is never re-derived.** `GET .../results?periodId=…` reads `startsOn`,
 * `endsOn` and `timezone` off the `ReportPeriod` row and uses them verbatim.
 * Only a request that names no period gets a freshly computed window, and that
 * window is labelled `stored: false` with a sentence saying it will move —
 * because "last 30 days" answers a different question tomorrow, and serving an
 * old report from today's clock is exactly the bug G13 calls out.
 *
 * Windows are resolved in the period's timezone, not the server's and not the
 * viewer's. A "March 2026" report therefore covers the same instants in March
 * and in September, on any host.
 *
 * @module period.service
 */

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import type { ResultsWindow } from './results.types';
import { DEFAULT_WINDOW_DAYS } from './results.types';
import { daysBetween, isValidTimeZone, resolveBound } from './results.util';
import type { CreatePeriodDto, UpdatePeriodDto } from './dto/period.dto';

/** The `ReportPeriod` columns this service reads. */
export interface PeriodRow {
  id: string;
  projectId: string;
  label: string;
  startsOn: Date;
  endsOn: Date;
  timezone: string;
  cohortId: string | null;
  baselinePeriodId: string | null;
  createdAt: Date;
}

/** What the caller asked for. Every field optional; precedence is documented on {@link resolveWindow}. */
export interface WindowRequest {
  periodId?: string;
  from?: string;
  to?: string;
  timezone?: string;
}

@Injectable()
export class PeriodService {
  constructor(private readonly prisma: PrismaService) {}

  async list(projectId: string): Promise<PeriodRow[]> {
    return this.prisma.reportPeriod.findMany({ where: { projectId }, orderBy: { startsOn: 'desc' } });
  }

  /** One period, resolved inside its project. */
  async get(projectId: string, id: string): Promise<PeriodRow> {
    const row = await this.prisma.reportPeriod.findFirst({ where: { id, projectId } });
    if (!row) throw new NotFoundException(`Report period ${id} not found for project ${projectId}`);
    return row;
  }

  /**
   * Create a period.
   *
   * `baselinePeriodId` is validated against this project, and a period cannot
   * be its own baseline. Bounds are resolved in `timezone` at the moment of
   * creation and then frozen — the stored `startsOn`/`endsOn` are instants,
   * not wall-clock strings, so no later timezone change can shift them.
   */
  async create(projectId: string, dto: CreatePeriodDto): Promise<PeriodRow> {
    const timezone = dto.timezone ?? 'UTC';
    if (!isValidTimeZone(timezone)) {
      throw new BadRequestException(`"${timezone}" is not an IANA timezone name this server recognises`);
    }

    const startsOn = resolveBound(dto.startsOn, 'from', timezone);
    const endsOn = resolveBound(dto.endsOn, 'to', timezone);
    if (endsOn.getTime() < startsOn.getTime()) {
      throw new BadRequestException(`endsOn (${dto.endsOn}) is before startsOn (${dto.startsOn})`);
    }

    if (dto.cohortId) await this.assertCohortBelongsToProject(dto.cohortId, projectId);
    if (dto.baselinePeriodId) await this.assertPeriodBelongsToProject(dto.baselinePeriodId, projectId);

    return this.prisma.reportPeriod.create({
      data: {
        projectId,
        label: dto.label,
        startsOn,
        endsOn,
        timezone,
        cohortId: dto.cohortId ?? null,
        baselinePeriodId: dto.baselinePeriodId ?? null,
      },
    });
  }

  /**
   * Edit a period.
   *
   * A period whose window has been **pinned by an evidence manifest is
   * immutable**. The manifest names the exact source rows a report was built
   * from; widening the period afterwards would leave that manifest describing
   * a window it was never built for, which is precisely the "old reports must
   * not change" guarantee §6.4 makes. Label, cohort and baseline stay editable,
   * because none of them re-point the source rows.
   */
  async update(projectId: string, id: string, dto: UpdatePeriodDto): Promise<PeriodRow> {
    const current = await this.get(projectId, id);

    const timezone = dto.timezone ?? current.timezone;
    if (!isValidTimeZone(timezone)) {
      throw new BadRequestException(`"${timezone}" is not an IANA timezone name this server recognises`);
    }

    const windowMoves = dto.startsOn !== undefined || dto.endsOn !== undefined || dto.timezone !== undefined;
    if (windowMoves) {
      const pin = await this.prisma.evidenceManifest.findFirst({
        where: { projectId, periodId: id },
        select: { id: true, subjectType: true, subjectId: true },
      });
      if (pin) {
        throw new ConflictException(
          `Period ${id}'s window is pinned by evidence manifest ${pin.id} (${pin.subjectType}` +
            `${pin.subjectId ? ` ${pin.subjectId}` : ''}), which names the exact sources the snapshot was built from. ` +
            'Create a new period for the corrected window instead of moving this one.',
        );
      }
    }

    const startsOn = dto.startsOn !== undefined ? resolveBound(dto.startsOn, 'from', timezone) : current.startsOn;
    const endsOn = dto.endsOn !== undefined ? resolveBound(dto.endsOn, 'to', timezone) : current.endsOn;
    if (endsOn.getTime() < startsOn.getTime()) {
      throw new BadRequestException('The edited window ends before it starts');
    }

    if (dto.cohortId) await this.assertCohortBelongsToProject(dto.cohortId, projectId);
    if (dto.baselinePeriodId) {
      if (dto.baselinePeriodId === id) throw new BadRequestException('A period cannot be its own baseline');
      await this.assertPeriodBelongsToProject(dto.baselinePeriodId, projectId);
    }

    return this.prisma.reportPeriod.update({
      where: { id },
      data: {
        label: dto.label ?? current.label,
        startsOn,
        endsOn,
        timezone,
        cohortId: dto.cohortId ?? current.cohortId,
        baselinePeriodId: dto.baselinePeriodId ?? current.baselinePeriodId,
      },
    });
  }

  /**
   * Decide the window for a read.
   *
   * Precedence, and the response always states which rung was used:
   *
   * 1. `periodId` — a stored period. Bounds and timezone come from the row.
   *    `stored: true`, and the same URL returns the same window forever.
   * 2. `from`/`to` — resolved in `timezone` (request, else the project's).
   *    `stored: false`; a bare date means the whole day in that zone.
   * 3. Neither — a documented rolling window ending now. `stored: false` with
   *    a note saying the window is derived from today and will not reproduce.
   *
   * @throws BadRequestException an unparseable bound, an invalid timezone, or
   *         a window that ends before it starts.
   */
  async resolveWindow(
    projectId: string,
    request: WindowRequest,
    projectTimezone: string,
  ): Promise<{ window: ResultsWindow; period: PeriodRow | null }> {
    if (request.periodId) {
      const period = await this.get(projectId, request.periodId);
      return { window: this.windowOfPeriod(period), period };
    }

    const timezone = request.timezone ?? projectTimezone ?? 'UTC';
    if (!isValidTimeZone(timezone)) {
      throw new BadRequestException(`"${timezone}" is not an IANA timezone name this server recognises`);
    }

    if (request.from || request.to) {
      const endsOn = request.to ? resolveBound(request.to, 'to', timezone) : new Date();
      // A request with only `to` gets `DEFAULT_WINDOW_DAYS` of lead-in rather
      // than an unbounded lookback, so the denominator is always stated.
      const startsOn = request.from
        ? resolveBound(request.from, 'from', timezone)
        : new Date(endsOn.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000);
      if (Number.isNaN(startsOn.getTime()) || Number.isNaN(endsOn.getTime())) {
        throw new BadRequestException('from/to must each be a YYYY-MM-DD date or an ISO 8601 timestamp');
      }
      if (endsOn.getTime() < startsOn.getTime()) {
        throw new BadRequestException('`to` is before `from` — the window is empty, which is not the same as unmeasured');
      }
      return {
        window: {
          appliedBy: 'request',
          periodId: null,
          label: null,
          startsOn: startsOn.toISOString(),
          endsOn: endsOn.toISOString(),
          timezone,
          stored: false,
          days: daysBetween(startsOn, endsOn),
          reproducibilityNote:
            'This window was assembled from the request, not from a stored ReportPeriod. ' +
            'Repeating the same URL with relative bounds returns a different window; ' +
            'store a ReportPeriod to freeze it.',
        },
        period: null,
      };
    }

    const endsOn = new Date();
    const startsOn = new Date(endsOn.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000);
    return {
      window: {
        appliedBy: 'default',
        periodId: null,
        label: `Last ${DEFAULT_WINDOW_DAYS} days (rolling)`,
        startsOn: startsOn.toISOString(),
        endsOn: endsOn.toISOString(),
        timezone,
        stored: false,
        days: DEFAULT_WINDOW_DAYS,
        reproducibilityNote:
          `This is the default rolling ${DEFAULT_WINDOW_DAYS}-day window, derived from today's date. ` +
          'It is not reproducible: the same request tomorrow covers different days. ' +
          'Read a stored period (`?periodId=`) for a window that a report can be reproduced from.',
      },
      period: null,
    };
  }

  /**
   * Resolve the period a comparison runs against.
   *
   * Accepts a `ReportPeriod` id. Also accepts a `MeasurementCohort` id, which
   * means "the earliest period measured under that cohort" — deterministic and
   * stated, rather than a guess. `previous` selects the latest stored period
   * that ended before the served one begins; that selection is a heuristic, but
   * the *window* it returns is stored and exact, and the response says which
   * rung was taken.
   *
   * @throws BadRequestException the id names something unrecognised, or names a
   *         cohort with no period to compare against.
   */
  async resolveBaseline(
    projectId: string,
    baselineId: string,
    served: { period: PeriodRow | null; window: ResultsWindow },
  ): Promise<{ period: PeriodRow; resolvedFrom: 'period' | 'cohort' | 'previous' }> {
    if (baselineId === 'previous') {
      if (!served.period) {
        throw new BadRequestException(
          'baselineId=previous needs a stored period to look back from. Read a period (`?periodId=`) first, or name an explicit baseline period.',
        );
      }
      const previous = await this.prisma.reportPeriod.findFirst({
        where: { projectId, endsOn: { lt: served.period.startsOn } },
        orderBy: { endsOn: 'desc' },
      });
      if (!previous) {
        throw new NotFoundException('No stored period ends before this one starts, so there is no previous period to compare against');
      }
      return { period: previous, resolvedFrom: 'previous' };
    }

    const asPeriod = await this.prisma.reportPeriod.findFirst({ where: { id: baselineId, projectId } });
    if (asPeriod) return { period: asPeriod, resolvedFrom: 'period' };

    const asCohort = await this.prisma.measurementCohort.findFirst({ where: { id: baselineId, projectId } });
    if (asCohort) {
      const earliest = await this.prisma.reportPeriod.findFirst({
        where: { projectId, cohortId: asCohort.id },
        orderBy: { startsOn: 'asc' },
      });
      if (!earliest) {
        throw new BadRequestException(
          `Cohort ${baselineId} (${asCohort.name}) has no ReportPeriod, so there is no window to compare against. ` +
            'Create a period for it first, or pass a ReportPeriod id as baselineId.',
        );
      }
      return { period: earliest, resolvedFrom: 'cohort' };
    }

    throw new NotFoundException(`Baseline ${baselineId} is neither a report period nor a measurement cohort on project ${projectId}`);
  }

  /** The window a stored period describes. Never recomputed. */
  windowOfPeriod(period: PeriodRow): ResultsWindow {
    return {
      appliedBy: 'period',
      periodId: period.id,
      label: period.label,
      startsOn: period.startsOn.toISOString(),
      endsOn: period.endsOn.toISOString(),
      timezone: period.timezone,
      stored: true,
      days: daysBetween(period.startsOn, period.endsOn),
      reproducibilityNote: null,
    };
  }

  /** A window built from a period's bounds without loading it as a served period (used for the baseline). */
  windowOfBaseline(period: PeriodRow): ResultsWindow {
    return { ...this.windowOfPeriod(period), appliedBy: 'period' };
  }

  private async assertCohortBelongsToProject(cohortId: string, projectId: string): Promise<void> {
    const found = await this.prisma.measurementCohort.findFirst({ where: { id: cohortId, projectId }, select: { id: true } });
    if (!found) throw new NotFoundException(`Measurement cohort ${cohortId} not found for project ${projectId}`);
  }

  private async assertPeriodBelongsToProject(periodId: string, projectId: string): Promise<void> {
    const found = await this.prisma.reportPeriod.findFirst({ where: { id: periodId, projectId }, select: { id: true } });
    if (!found) throw new NotFoundException(`Report period ${periodId} not found for project ${projectId}`);
  }
}
