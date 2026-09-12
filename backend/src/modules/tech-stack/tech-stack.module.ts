/**
 * Tech Stack Module — technology-stack fingerprinting (wave-6, D3/step 3).
 *
 * Deterministic signature matching over headers/HTML/scripts fetcher already
 * retrieves — no new dependency, no per-lookup cost, runs against any domain
 * (so wave-6's later `competitors` module can reuse `scanDomain` unchanged).
 *
 * Depends on: FetcherModule (the one fetch per scan)
 *
 * @module tech-stack.module
 */

import { Module } from '@nestjs/common';
import { TechStackService } from './tech-stack.service';
import { TechStackController } from './tech-stack.controller';
import { FetcherModule } from '../fetcher/fetcher.module';

@Module({
  imports: [FetcherModule],
  controllers: [TechStackController],
  providers: [TechStackService],
  exports: [TechStackService],
})
export class TechStackModule {}
