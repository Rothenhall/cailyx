/**
 * Measurement Module — AI surface observation engine (Wave 1, PRD §6.6-6.7).
 *
 * The moat: runs every active-set prompt n>=5 times per surface per geo,
 * records structured Observations, and aggregates rates + share of voice.
 * Surfaces are adapters behind one interface: the three consumer answer
 * engines driven in a browser (ChatGPT, Perplexity, Gemini — all gated), the
 * first-party Claude and Perplexity APIs, and a test-only mock.
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
import {
  ChatGptBrowserAdapter,
  GeminiBrowserAdapter,
  PerplexityBrowserAdapter,
} from './adapters/browser-surface.adapter';
import {
  CloroAiModeAdapter,
  CloroChatGptAdapter,
  CloroClient,
  CloroGeminiAdapter,
  CloroGoogleAiOverviewAdapter,
  CloroPerplexityAdapter,
} from './adapters/cloro.adapter';

@Module({
  controllers: [MeasurementController],
  providers: [
    MeasurementService,
    AnthropicSurfaceAdapter,
    PerplexitySurfaceAdapter,
    ChatGptBrowserAdapter,
    PerplexityBrowserAdapter,
    GeminiBrowserAdapter,
    CloroClient,
    CloroChatGptAdapter,
    CloroPerplexityAdapter,
    CloroGeminiAdapter,
    CloroGoogleAiOverviewAdapter,
    CloroAiModeAdapter,
    MockSurfaceAdapter,
  ],
  exports: [
    MeasurementService,
    AnthropicSurfaceAdapter,
    PerplexitySurfaceAdapter,
    ChatGptBrowserAdapter,
    PerplexityBrowserAdapter,
    GeminiBrowserAdapter,
    CloroClient,
    CloroChatGptAdapter,
    CloroPerplexityAdapter,
    CloroGeminiAdapter,
    CloroGoogleAiOverviewAdapter,
    CloroAiModeAdapter,
    MockSurfaceAdapter,
  ],
})
export class MeasurementModule {}