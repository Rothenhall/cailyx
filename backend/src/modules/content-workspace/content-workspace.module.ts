/**
 * Content Workspace Module — P08.
 *
 * @module content-workspace.module
 */

import { Module } from '@nestjs/common';
import { ContentWorkspaceController } from './content-workspace.controller';
import { ContentWorkspaceService } from './content-workspace.service';

@Module({
  controllers: [ContentWorkspaceController],
  providers: [ContentWorkspaceService],
  exports: [ContentWorkspaceService],
})
export class ContentWorkspaceModule {}
