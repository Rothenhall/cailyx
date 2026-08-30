/**
 * Data Asset Service — original-data-asset tracker (SOP-8, P3).
 *
 * Minimal lifecycle tracker (planned → fielding → published): a data asset
 * earns AI citations/links when it is named after the client brand (or
 * unambiguously subject-matter), carries a sourceable methodology note, and
 * publishes numbers other pages can cite.
 *
 * @module data-asset.service
 */

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

const STATUSES = ['planned', 'fielding', 'published'] as const;

@Injectable()
export class DataAssetService {
  constructor(private readonly prisma: PrismaService) {}

  async create(projectId: string, data: { title: string; brandAlignment?: string; methodologyNote?: string; surveySize?: number; assetUrl?: string }) {
    await this.assertProject(projectId);
    if (!['brand-named', 'subject-matter'].includes(data.brandAlignment ?? 'brand-named')) {
      throw new BadRequestException('brandAlignment must be brand-named | subject-matter');
    }
    return this.prisma.dataAsset.create({
      data: {
        projectId,
        title: data.title,
        brandAlignment: data.brandAlignment || 'brand-named',
        methodologyNote: data.methodologyNote || null,
        surveySize: data.surveySize ?? null,
        assetUrl: data.assetUrl || null,
      },
    });
  }

  async list(projectId: string) {
    return this.prisma.dataAsset.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } });
  }

  async update(projectId: string, assetId: string, patch: { title?: string; brandAlignment?: string; methodologyNote?: string; surveySize?: number; assetUrl?: string; status?: string }) {
    const asset = await this.assertAsset(projectId, assetId);
    if (patch.status && !(STATUSES as readonly string[]).includes(patch.status)) {
      throw new BadRequestException('status must be planned | fielding | published');
    }
    if (patch.brandAlignment && !['brand-named', 'subject-matter'].includes(patch.brandAlignment)) {
      throw new BadRequestException('brandAlignment must be brand-named | subject-matter');
    }
    return this.prisma.dataAsset.update({
      where: { id: asset.id },
      data: {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.brandAlignment !== undefined ? { brandAlignment: patch.brandAlignment } : {}),
        ...(patch.methodologyNote !== undefined ? { methodologyNote: patch.methodologyNote || null } : {}),
        ...(patch.surveySize !== undefined ? { surveySize: patch.surveySize ?? null } : {}),
        ...(patch.assetUrl !== undefined ? { assetUrl: patch.assetUrl || null } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.status === 'published' ? { publishedAt: new Date() } : {}),
      },
    });
  }

  async delete(projectId: string, assetId: string) {
    const asset = await this.assertAsset(projectId, assetId);
    await this.prisma.dataAsset.delete({ where: { id: asset.id } });
    return { deleted: true };
  }

  // ─── Privates ──────────────────────────────────────────────────

  private async assertProject(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + projectId);
  }

  private async assertAsset(projectId: string, assetId: string) {
    const asset = await this.prisma.dataAsset.findUnique({ where: { id: assetId } });
    if (!asset || asset.projectId !== projectId) {
      throw new NotFoundException('Data asset not found in this project: ' + assetId);
    }
    return asset;
  }
}