/**
 * Pipeline Math Service — GTM Playbook qualification arithmetic.
 *
 * The chain (PLAN §5 Phase 4):
 *   revenueTarget ÷ ACV = deals
 *   ÷ winRate       = SQLs
 *   ÷ meetingToSql  = booked meetings
 *   ÷ leadToMeeting = leads
 *   ÷ visitorToLead = visitors needed
 * Compared against the addressable market → verdict feasible | fiction.
 *
 * One row per project (unique). Every intermediate stage is persisted, not
 * just the verdict, so discovery-call arithmetic is auditable later.
 *
 * @module pipeline-math.service
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { SavePipelineMathDto } from './dto/pipeline-math.dto';
import { FICTION_FACTOR, PipelineStages, PipelineVerdict } from './pipeline-math.types';

interface StageInput {
  revenueTarget: number;
  acv: number;
  winRate: number;
  meetingToSql: number;
  leadToMeeting: number;
  visitorToLead: number;
  marketSize?: number;
}

@Injectable()
export class PipelineMathService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The qualification chain. Stages are rounded up to whole units — you
   * cannot win 0.3 of a deal or book 0.7 of a meeting.
   */
  computeStages(input: StageInput): PipelineStages {
    const deals = Math.ceil(input.revenueTarget / input.acv);
    const sqls = Math.ceil(deals / input.winRate);
    const meetings = Math.ceil(sqls / input.meetingToSql);
    const leads = Math.ceil(meetings / input.leadToMeeting);
    const visitors = Math.ceil(leads / input.visitorToLead);
    return { deals, sqls, meetings, leads, visitors };
  }

  /**
   * Verdict: feasible unless a market size was supplied and the required
   * visitors exceed 1.5× it (the FICTION_FACTOR threshold is disclosed in
   * every response — a plan needing 1.5× the reachable market is fiction).
   */
  verdictFor(stages: PipelineStages, marketSize?: number): { verdict: PipelineVerdict; ratio: number | null } {
    if (!marketSize) return { verdict: 'feasible', ratio: null };
    const ratio = stages.visitors / marketSize;
    return { verdict: ratio > FICTION_FACTOR ? 'fiction' : 'feasible', ratio };
  }

  /** Create or replace the project's model (one row per project). */
  async save(projectId: string, dto: SavePipelineMathDto) {
    await this.assertProject(projectId);
    const stages = this.computeStages(dto);
    const { verdict, ratio } = this.verdictFor(stages, dto.marketSize);
    const row = await this.prisma.pipelineMath.upsert({
      where: { projectId },
      create: { projectId, ...dto, stages: JSON.stringify(stages), verdict },
      update: { ...dto, stages: JSON.stringify(stages), verdict },
    });
    return this.present(row, stages, ratio);
  }

  /** The project's current model (404 with a hint when never computed). */
  async get(projectId: string) {
    const row = await this.prisma.pipelineMath.findUnique({ where: { projectId } });
    if (!row) {
      throw new NotFoundException(
        `No pipeline model for this project yet — PUT /api/projects/${projectId}/pipeline-math with the plan numbers to compute one.`,
      );
    }
    return this.present(row, JSON.parse(row.stages) as PipelineStages);
  }

  /** Recompute with partially-updated inputs (unspecified fields keep the stored value). */
  async recalc(projectId: string, patch: Partial<SavePipelineMathDto>) {
    const row = await this.prisma.pipelineMath.findUnique({ where: { projectId } });
    if (!row) {
      throw new NotFoundException(
        `No pipeline model for this project yet — PUT /api/projects/${projectId}/pipeline-math to create one.`,
      );
    }
    const merged: SavePipelineMathDto = {
      revenueTarget: patch.revenueTarget ?? row.revenueTarget,
      acv: patch.acv ?? row.acv,
      winRate: patch.winRate ?? row.winRate,
      meetingToSql: patch.meetingToSql ?? row.meetingToSql,
      leadToMeeting: patch.leadToMeeting ?? row.leadToMeeting,
      visitorToLead: patch.visitorToLead ?? row.visitorToLead,
      marketSize: patch.marketSize !== undefined ? patch.marketSize : row.marketSize ?? undefined,
    };
    return this.save(projectId, merged);
  }

  private async assertProject(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
  }

  /** Wire format: stored columns + the parsed stage chain + ratio detail. */
  private present(
    row: { [k: string]: unknown; stages: string; verdict: string },
    stages: PipelineStages,
    ratio?: number | null,
  ) {
    return {
      ...row,
      stages,
      fictionFactor: FICTION_FACTOR,
      ratio: ratio ?? (row.marketSize ? stages.visitors / (row.marketSize as number) : null),
    };
  }
}