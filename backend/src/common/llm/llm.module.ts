/**
 * LlmModule — global, so every module gets `LlmService` without adding it to
 * their own `imports:` array (same convention `DatabaseModule` uses for
 * `PrismaService`). Registered once in `AppModule`.
 *
 * @module llm.module
 */

import { Global, Module } from '@nestjs/common';
import { LlmService } from './llm.service';

@Global()
@Module({
  providers: [LlmService],
  exports: [LlmService],
})
export class LlmModule {}
