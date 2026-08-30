/**
 * Cost Tracker Service — Per-run cost tracking and budget enforcement.
 *
 * Tracks the cost of each fetcher operation per run.
 * Enforces a per-run budget — if exceeded, the fetcher refuses the call.
 * Uses in-memory tracking (no Redis needed).
 *
 * @module fetcher.cost-tracker
 */

import { Injectable, Logger } from '@nestjs/common';
import type { CostEntry } from '../fetcher.types';

@Injectable()
export class CostTrackerService {
  private readonly logger = new Logger(CostTrackerService.name);
  private readonly costs = new Map<string, CostEntry[]>();

  /**
   * Track a cost entry for a run.
   */
  trackCost(runId: string, cost: number, method: string): void {
    const entry: CostEntry = {
      runId,
      method,
      cost,
      timestamp: new Date().toISOString(),
    };

    let entries = this.costs.get(runId);
    if (!entries) {
      entries = [];
      this.costs.set(runId, entries);
    }
    entries.push(entry);

    if (cost > 0) {
      this.logger.debug(`Cost tracked: run=${runId} method=${method} cost=$${cost.toFixed(4)}`);
    }
  }

  /**
   * Get the total cost for a run.
   */
  getRunCost(runId: string): number {
    const entries = this.costs.get(runId);
    if (!entries) return 0;
    return entries.reduce((sum, e) => sum + e.cost, 0);
  }

  /**
   * Check if a run has exceeded its budget.
   * @returns true if the budget allows another call, false if exceeded
   */
  checkBudget(runId: string, budget: number): boolean {
    const currentCost = this.getRunCost(runId);
    if (currentCost >= budget) {
      this.logger.warn(
        `Budget exceeded for run ${runId}: $${currentCost.toFixed(4)} >= $${budget.toFixed(4)}`,
      );
      return false;
    }
    return true;
  }

  /**
   * Get all cost entries for a run (for reporting).
   */
  getRunEntries(runId: string): CostEntry[] {
    return this.costs.get(runId) || [];
  }

  /**
   * Clear cost data for a run (called when a run completes or is discarded).
   */
  clearRun(runId: string): void {
    this.costs.delete(runId);
  }
}