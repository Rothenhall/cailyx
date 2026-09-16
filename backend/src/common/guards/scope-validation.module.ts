/**
 * ScopeValidationModule — registers {@link ScopeValidationService} as a
 * global provider (mirrors DatabaseModule's own `@Global()` pattern) so any
 * module can inject it without adding an explicit import. It is activated by
 * AuthModule importing it once; Nest's `@Global()` then makes the export
 * available application-wide regardless of which module pulled it in first.
 *
 * @module scope-validation.module
 */

import { Global, Module } from '@nestjs/common';
import { ScopeValidationService } from './scope-validation.service';

@Global()
@Module({
  providers: [ScopeValidationService],
  exports: [ScopeValidationService],
})
export class ScopeValidationModule {}
