/**
 * Data Asset Controller — REST surface for SOP-8 (P3).
 *
 * @module data-asset.controller
 */

import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DataAssetService } from './data-asset.service';
import { CreateDataAssetDto, UpdateDataAssetDto } from './dto/data-asset.dto';

@ApiTags('Data Asset')
@Controller('projects/:projectId/data-asset')
export class DataAssetController {
  constructor(private readonly dataAsset: DataAssetService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a data-asset track', description: 'Minimal SOP-8 tracker: title, brand alignment (brand-named earns citations more reliably), methodology note, survey size, lifecycle.' })
  @ApiResponse({ status: 201, description: 'Asset created' })
  async create(@Param('projectId') projectId: string, @Body() body: CreateDataAssetDto) {
    return this.dataAsset.create(projectId, body);
  }

  @Get()
  @ApiOperation({ summary: 'List data assets (newest first)' })
  async list(@Param('projectId') projectId: string) {
    return this.dataAsset.list(projectId);
  }

  @Patch(':assetId')
  @ApiOperation({ summary: 'Update an asset (fields + lifecycle; published stamps publishedAt)' })
  async update(@Param('projectId') projectId: string, @Param('assetId') assetId: string, @Body() body: UpdateDataAssetDto) {
    return this.dataAsset.update(projectId, assetId, body);
  }

  @Delete(':assetId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an asset track' })
  async delete(@Param('projectId') projectId: string, @Param('assetId') assetId: string) {
    return this.dataAsset.delete(projectId, assetId);
  }
}