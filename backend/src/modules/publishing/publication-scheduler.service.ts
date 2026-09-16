/**
 * PublicationSchedulerService — dispatches scheduled publications when their
 * time arrives.
 *
 * A `scheduledFor` that nothing ever acts on would be a promise the system does
 * not keep, so something has to look at the clock. This is an in-process cron
 * (`@nestjs/schedule`, already registered globally) rather than a queue job,
 * for the same reason the audit scheduler is: it needs no Redis, it survives a
 * restart because the schedule lives in the database, and a scheduling feature
 * that silently does nothing when infrastructure is down is worse than none.
 *
 * **It is not a second path to a remote write.** Every row it picks up goes
 * through `PublishingService.dispatch`, which re-checks the whole gate set
 * immediately before the write: the destination is connected and not revoked,
 * the recorded approval is still `approved`, the client is not paused, and the
 * row has no `remoteId` yet. A publication whose approval was invalidated while
 * it waited stays `pending` and reports why, rather than going out under stale
 * consent.
 *
 * Set `PUBLISHING_SCHEDULER_ENABLED=false` to stand it down (a second instance,
 * or an environment where nothing should publish itself).
 *
 * @module publication-scheduler.service
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import { PublishingService, STALE_PUBLISHING_MS } from './publishing.service';

/** How many due rows one tick will attempt. Bounds a burst. */
const TICK_BATCH = 20;

@Injectable()
export class PublicationSchedulerService {
  private readonly logger = new Logger(PublicationSchedulerService.name);

  /**
   * In-process overlap guard. A push is a network round trip plus a
   * verification fetch, so a slow provider could still be running when the next
   * minute's tick fires; two dispatchers on one row would be exactly the
   * duplicate remote post the retry rules exist to prevent.
   */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly publishing: PublishingService,
    private readonly config: ConfigService,
  ) {}

  private get enabled(): boolean {
    return this.config.get<string>('PUBLISHING_SCHEDULER_ENABLED', 'true') !== 'false';
  }

  /**
   * Every minute: dispatch what is due, and report anything stuck mid-dispatch.
   *
   * A row stuck in `publishing` means the process died between marking the row
   * and finishing the push — so it may or may not exist at the remote system.
   * It is never auto-reset (that is how a double post happens); it is surfaced
   * for a human, and `retry` on it demands an explicit confirmation.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'publication-dispatch' })
  async tick(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.running = true;

    try {
      const due = await this.publishing.findDuePublications(new Date(), TICK_BATCH);
      let dispatched = 0;
      const blocks = new Map<string, number>();

      for (const id of due) {
        const outcome = await this.publishing.dispatch(id, 'scheduler');
        if (outcome.dispatched) {
          dispatched += 1;
        } else if (outcome.error) {
          this.logger.warn(`Publication ${id} failed to dispatch: ${outcome.error}`);
        } else if (outcome.blockedReason) {
          blocks.set(outcome.blockedReason, (blocks.get(outcome.blockedReason) ?? 0) + 1);
        }
      }

      if (dispatched > 0) {
        this.logger.log(`Dispatched ${dispatched} scheduled publication(s)`);
      }
      if (blocks.size > 0) {
        // Not a warning: a held publication is a state the operator sees on the
        // row itself. Logged at debug so a permanently blocked row cannot flood
        // the log once a minute.
        this.logger.debug(
          `Held publications: ${Array.from(blocks.entries())
            .map(([reason, count]) => `${count}× ${reason}`)
            .join('; ')}`,
        );
      }

      const staleCutoff = new Date(Date.now() - STALE_PUBLISHING_MS);
      const stale = await this.prisma.publication.count({
        where: { status: 'publishing', updatedAt: { lt: staleCutoff } },
      });
      if (stale > 0) {
        this.logger.warn(
          `${stale} publication(s) have been in "publishing" for more than ` +
            `${Math.round(STALE_PUBLISHING_MS / 60000)} minutes. They are not reset automatically — ` +
            'a human must confirm nothing reached the remote system before retrying.',
        );
      }
    } catch (err) {
      this.logger.error(`Publication dispatch tick failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      this.running = false;
    }
  }
}
