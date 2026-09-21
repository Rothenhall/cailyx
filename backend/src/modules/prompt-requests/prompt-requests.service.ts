/**
 * Prompt Requests Service — the lightweight prompt add/delete request queue
 * (client-portal.md §13, §20; PLAN.md §11.4 Phase C4).
 *
 * A client submits a request; it lands here with a quota snapshot. An admin
 * acts on it directly through the existing `query-set` module's own
 * edit/versioning endpoints (this service never touches `QuerySet` or
 * `QuerySetItem`), then records the decision via {@link decide}.
 *
 * @module prompt-requests.service
 */

import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { promptLimitForTier, tierSlugFromOfferText, isPlanTierSlug } from './plan-tier.util';
import type {
  CreatePromptRequestInput,
  DecidePromptRequestInput,
  PlanTierSlug,
  PromptRequestDto,
  PromptRequestStatus,
} from './prompt-requests.types';

@Injectable()
export class PromptRequestsService {
  private readonly logger = new Logger(PromptRequestsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * §20 — resolve the client's plan tier from `Client.planTier` (added by
   * Phase C7, merged after this module was first written — see
   * `plan-tier.util.ts`'s header for the now-superseded derivation this
   * replaced). Falls back to deriving from the most recent live
   * subscription's `Offer.code`/`Offer.name` only if `planTier` is somehow
   * an unrecognized value, so a bad/legacy row still degrades to a
   * conservative guess rather than throwing.
   */
  async resolvePlanTier(clientId: string): Promise<PlanTierSlug> {
    const client = await this.prisma.client.findUnique({
      where: { id: clientId },
      select: { planTier: true },
    });
    if (client && isPlanTierSlug(client.planTier)) return client.planTier;

    const subscription = await this.prisma.subscription.findFirst({
      where: { clientId, status: { in: ['active', 'trialing', 'past-due'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!subscription?.offerId) return 'starter';
    const offer = await this.prisma.offer.findUnique({ where: { id: subscription.offerId } });
    return tierSlugFromOfferText(offer?.code) ?? tierSlugFromOfferText(offer?.name) ?? 'starter';
  }

  /** The project's current active-prompt count — every item on every `active` QuerySet. */
  async activePromptCount(projectId: string): Promise<number> {
    return this.prisma.querySetItem.count({
      where: { querySet: { projectId, status: 'active' } },
    });
  }

  /**
   * Create a prompt request, computing and snapshotting the §20 quota check
   * at request time. Over-quota is flagged (`overQuota: true`), never
   * rejected — per §20 it is an upsell moment for the admin, not a failure.
   */
  async create(input: CreatePromptRequestInput): Promise<PromptRequestDto> {
    if (input.action === 'add' && !input.prompt?.trim()) {
      throw new ConflictException('A prompt-add request needs prompt text');
    }
    if (input.action === 'remove' && !input.targetItemId) {
      throw new ConflictException('A prompt-removal request needs targetItemId');
    }

    let targetPromptText: string | null = null;
    if (input.action === 'remove' && input.targetItemId) {
      const item = await this.prisma.querySetItem.findUnique({ where: { id: input.targetItemId } });
      if (!item) throw new NotFoundException(`Query set item not found: ${input.targetItemId}`);
      targetPromptText = item.prompt;
    }

    const [planTier, activeCount] = await Promise.all([
      this.resolvePlanTier(input.clientId),
      this.activePromptCount(input.projectId),
    ]);
    const planPromptLimit = promptLimitForTier(planTier);
    const overQuota = input.action === 'add' && planPromptLimit !== null && activeCount >= planPromptLimit;

    const row = await this.prisma.promptRequest.create({
      data: {
        projectId: input.projectId,
        clientId: input.clientId,
        requestedByUserId: input.requestedByUserId,
        action: input.action,
        prompt: input.action === 'add' ? input.prompt!.trim() : null,
        persona: input.persona ?? null,
        targetItemId: input.action === 'remove' ? input.targetItemId ?? null : null,
        targetPromptText,
        note: input.note ?? null,
        status: 'pending',
        activePromptCount: activeCount,
        planPromptLimit,
        planTier,
        overQuota,
      },
    });
    this.logger.log(
      `Prompt request ${row.id} created (project=${input.projectId}, action=${input.action}, overQuota=${overQuota})`,
    );
    return this.toDto(row);
  }

  async list(projectId: string, status?: PromptRequestStatus): Promise<PromptRequestDto[]> {
    const rows = await this.prisma.promptRequest.findMany({
      where: { projectId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toDto(r));
  }

  async listForClient(clientId: string, projectId: string): Promise<PromptRequestDto[]> {
    const rows = await this.prisma.promptRequest.findMany({
      where: { clientId, projectId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toDto(r));
  }

  /**
   * Record an admin's decision. Does NOT touch `QuerySet`/`QuerySetItem` —
   * the admin performs the actual add/remove through the `query-set`
   * module's own endpoints first (or declines outright), then calls this to
   * close the queue item, optionally citing the resulting item id.
   */
  async decide(id: string, input: DecidePromptRequestInput): Promise<PromptRequestDto> {
    const existing = await this.prisma.promptRequest.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Prompt request not found: ${id}`);
    if (existing.status !== 'pending') {
      throw new ConflictException(`Prompt request ${id} is already ${existing.status}`);
    }
    const row = await this.prisma.promptRequest.update({
      where: { id },
      data: {
        status: input.decision,
        decidedByUserId: input.decidedByUserId,
        decidedAt: new Date(),
        decisionNote: input.decisionNote ?? null,
        resultQuerySetItemId: input.resultQuerySetItemId ?? null,
      },
    });
    this.logger.log(`Prompt request ${id} decided: ${input.decision} by ${input.decidedByUserId}`);
    return this.toDto(row);
  }

  private toDto(row: {
    id: string;
    projectId: string;
    clientId: string;
    requestedByUserId: string;
    action: string;
    prompt: string | null;
    persona: string | null;
    targetItemId: string | null;
    targetPromptText: string | null;
    note: string | null;
    status: string;
    activePromptCount: number;
    planPromptLimit: number | null;
    planTier: string;
    overQuota: boolean;
    decidedByUserId: string | null;
    decidedAt: Date | null;
    decisionNote: string | null;
    resultQuerySetItemId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): PromptRequestDto {
    return {
      id: row.id,
      projectId: row.projectId,
      clientId: row.clientId,
      requestedByUserId: row.requestedByUserId,
      action: row.action as PromptRequestDto['action'],
      prompt: row.prompt,
      persona: row.persona,
      targetItemId: row.targetItemId,
      targetPromptText: row.targetPromptText,
      note: row.note,
      status: row.status as PromptRequestStatus,
      activePromptCount: row.activePromptCount,
      planPromptLimit: row.planPromptLimit,
      planTier: row.planTier as PlanTierSlug,
      overQuota: row.overQuota,
      decidedByUserId: row.decidedByUserId,
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      decisionNote: row.decisionNote,
      resultQuerySetItemId: row.resultQuerySetItemId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
