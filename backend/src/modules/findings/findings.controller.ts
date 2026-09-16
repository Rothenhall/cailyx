/**
 * Findings Controller — what/why/fix copy API (FR-9.1–9.3).
 *
 * Routes:
 *   POST /api/projects/:projectId/findings/generate  generate findings from open gaps (LLM, claims-filtered)
 *   GET  /api/projects/:projectId/findings           list stored findings (thinRun flagged)
 *   GET  /api/projects/:projectId/findings/:findingId  one finding
 *
 * @module findings.controller
 */

import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags, type SchemaObject } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { FindingsService } from './findings.service';
import { GenerateFindingsDto } from './dto/findings.dto';

/**
 * A stored `Finding` row as Prisma returns it.
 *
 * Declared here because the wrapper is what this endpoint actually returns —
 * the checked-in `openapi.json` describes a bare array, which no caller has
 * ever received (G19/D12). The shape is NOT changed to match that document:
 * a frontend already normalizes the wrapper, and silently switching the wire
 * format to make a stale description true would break a working screen. The
 * description is corrected instead.
 *
 * The three copy fields carry both registers: `*Executive` is the client-facing
 * narrative, `*Technical` the operator-facing one. Each is nullable — a row
 * stored before the technical register existed has only the executive text.
 */
const FINDING_ROW_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['id', 'projectId', 'title', 'thinRun', 'createdAt'],
  properties: {
    id: { type: 'string' },
    projectId: { type: 'string' },
    gapId: { type: 'string', nullable: true, description: 'Source gap-analysis row, null when the finding was stored without one.' },
    title: { type: 'string' },
    whatExecutive: { type: 'string', nullable: true },
    whatTechnical: { type: 'string', nullable: true },
    whyExecutive: { type: 'string', nullable: true },
    whyTechnical: { type: 'string', nullable: true },
    fixExecutive: { type: 'string', nullable: true },
    fixTechnical: { type: 'string', nullable: true },
    thinRun: { type: 'boolean', description: 'True when the evidence behind this finding was below the non-obvious threshold.' },
    disclosedGap: { type: 'string', nullable: true, description: 'When thinRun, the honest note about which evidence is missing.' },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

@ApiTags('Findings')
@Controller('projects/:projectId/findings')
export class FindingsController {
  constructor(private readonly findingsService: FindingsService) {}

  @Post('generate')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @ApiOperation({
    summary: 'Generate findings from open gaps',
    description: 'Ranks open gaps, generates what/why/fix copy in executive + technical registers via a constrained LLM, filters through claims discipline (FR-9.4). Banned copy is regenerated once, then skipped. Flags thinRun when evidence is below the non-obvious threshold.',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ findings: Finding[], thinRun: boolean } — the rows stored by THIS call, newest first. An empty array is a real outcome (every gap skipped, e.g. copy that stayed banned after the retry) and is not the same as an error.',
    schema: {
      type: 'object',
      required: ['findings', 'thinRun'],
      properties: {
        findings: { type: 'array', items: FINDING_ROW_SCHEMA },
        thinRun: { type: 'boolean', description: 'True when fewer than three findings came back.' },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Project or gap analysis missing' })
  @ApiResponse({ status: 503, description: 'ANTHROPIC_API_KEY not configured' })
  async generate(@Param('projectId') projectId: string, @Body() body: GenerateFindingsDto) {
    return this.findingsService.generate(projectId, { limit: body.limit });
  }

  @Get()
  @ApiOperation({ summary: 'List stored findings', description: 'Newest first; thinRun=true when fewer than three findings exist.' })
  @ApiResponse({
    status: 200,
    description:
      '{ findings: Finding[], thinRun: boolean } — every finding stored for the project, newest first. Note this is the wrapper object, not a bare array.',
    schema: {
      type: 'object',
      required: ['findings', 'thinRun'],
      properties: {
        findings: { type: 'array', items: FINDING_ROW_SCHEMA },
        thinRun: { type: 'boolean', description: 'True when fewer than three findings are stored.' },
      },
    },
  })
  async list(@Param('projectId') projectId: string) {
    return this.findingsService.list(projectId);
  }

  @Get(':findingId')
  @ApiOperation({ summary: 'One finding with both registers' })
  @ApiResponse({ status: 200, description: 'A single Finding row (bare object, not wrapped)', schema: FINDING_ROW_SCHEMA })
  @ApiResponse({ status: 404, description: 'Finding not found in this project' })
  async getOne(@Param('projectId') projectId: string, @Param('findingId') findingId: string) {
    // findMany-based lookup keeps ownership in one where-clause.
    const rows = await this.findingsService.findingRows(projectId);
    const row = rows.find((f) => f.id === findingId);
    if (!row) throw new NotFoundException('Finding not found in this project: ' + findingId);
    return row;
  }
}