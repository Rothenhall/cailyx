/**
 * Capabilities Module — G18: the capability/readiness contract for every
 * provider-backed action.
 *
 * Contract source: design_plan.md Appendix A (G18).
 * Build spec: docs/analysis/design-plan-implementation.md
 *
 * `PrismaService` is global via `DatabaseModule` and `ScopeValidationService`
 * is global via `ScopeValidationModule` (activated in `AuthModule`) — neither
 * is imported here.
 *
 * `CapabilitiesService` is exported because it is **the contract other modules
 * adopt**, not just a read model:
 *
 * ```ts
 * // Wrap the provider call — readiness then updates itself.
 * return this.capabilities.withProbe('serp.dataforseo.serp', () => this.provider.fetch(...));
 *
 * // Or gate on it first, so the rule holds even for a caller that never saw a UI.
 * await this.capabilities.assertReady('serp.dataforseo.serp', projectId);
 * ```
 *
 * `verified` only ever becomes true from a recorded successful call. Nothing
 * else in this module — and nothing in any consumer — may infer it from
 * configuration.
 *
 * @module capabilities.module
 */

import { Module } from '@nestjs/common';
import {
  CapabilitiesController,
  PortalCapabilitiesController,
  ProjectCapabilitiesController,
} from './capabilities.controller';
import { CapabilitiesService } from './capabilities.service';

@Module({
  controllers: [CapabilitiesController, ProjectCapabilitiesController, PortalCapabilitiesController],
  providers: [CapabilitiesService],
  exports: [CapabilitiesService],
})
export class CapabilitiesModule {}
