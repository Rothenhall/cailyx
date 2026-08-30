/**
 * Measurement Module — AI surface observation engine (Wave 1, PRD §6.6-6.7).
 *
 * The moat: runs every active-set prompt n>=5 times per surface per geo,
 * records structured Observations, and aggregates rates + share of voice.
 * Surfaces are adapters — Claude and Perplexity in v1; ChatGPT/Google AIO
 * slot in behind the same interface later.
 *
 * Depends on: DatabaseModule (PrismaService)
 *
 * @module measurement.module
 */

import { Module } from '@nestjs/common';
import { MeasurementService } from './measurement.service';
import { MeasurementController } from './measurement.controller';
import { AnthropicSurfaceAdapter } from './adapters/anthropic.adapter';
import { PerplexitySurfaceAdapter } from './adapters/perplexity.adapter';
import { MockSurfaceAdapter } from './adapters/mock.adapter';

@Module({
  controllers: [MeasurementController],
  providers: [MeasurementService, AnthropicSurfaceAdapter, PerplexitySurfaceAdapter, MockSurfaceAdapter],
  exports: [MeasurementService, AnthropicSurfaceAdapter, PerplexitySurfaceAdapter, MockSurfaceAdapter],
})
export class MeasurementModule {}