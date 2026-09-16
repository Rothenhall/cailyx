/**
 * AttachmentsService — G08 file upload/download.
 *
 * Storage: local disk under `storage/attachments/<id>` (relative to the
 * backend process cwd). No multipart upload middleware is wired into this
 * app (no existing precedent in the codebase and the brief disallows new
 * dependencies), so the upload contract is a base64 JSON body — see
 * UploadAttachmentDto. `storageKey` on the row is an opaque id, never a
 * guessable path, and is never itself treated as a capability: every
 * download re-checks `visibility` and the caller's scope against the DB
 * row, per G08's non-negotiable #3.
 *
 * @module attachments.service
 */

import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { PrismaService } from '../database/prisma.service';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import type { AttachmentDto, DownloadedFileDto } from './notifications.types';

const STORAGE_ROOT = join(process.cwd(), 'storage', 'attachments');
/** 25MB — generous for briefs/screenshots/PDFs, bounded so a base64 JSON body can't exhaust process memory. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

@Injectable()
export class AttachmentsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Upload a file scoped to a project. Caller must be an operator (portal upload is a separate, narrower method). */
  async uploadForProject(
    projectId: string,
    uploader: AuthedRequestUser,
    dto: {
      filename: string;
      mimeType: string;
      contentBase64: string;
      contextType?: string;
      contextId?: string;
      clientId?: string;
      visibility?: string;
    },
  ): Promise<AttachmentDto> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true, clientId: true } });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    const buffer = this.decodeBounded(dto.contentBase64);
    const id = randomUUID();
    await this.writeToDisk(id, buffer);

    const row = await this.prisma.attachment.create({
      data: {
        clientId: dto.clientId ?? project.clientId ?? null,
        projectId,
        contextType: dto.contextType ?? 'message',
        contextId: dto.contextId ?? null,
        filename: dto.filename,
        mimeType: dto.mimeType,
        sizeBytes: buffer.byteLength,
        storageKey: id,
        visibility: dto.visibility ?? 'operator-only',
        uploadedBy: uploader.userId,
      },
    });
    return this.toDto(row);
  }

  async listForProject(projectId: string): Promise<{ attachments: AttachmentDto[] }> {
    const rows = await this.prisma.attachment.findMany({
      where: { projectId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return { attachments: rows.map((r) => this.toDto(r)) };
  }

  /**
   * Authorized download. The storage key is opaque — access is decided
   * entirely by this check, every call, against the current DB row (never
   * cached, never inferred from the URL). A client-type caller may only
   * reach `client-visible` attachments scoped to their own client.
   */
  async download(attachmentId: string, caller: AuthedRequestUser): Promise<DownloadedFileDto> {
    const row = await this.prisma.attachment.findUnique({ where: { id: attachmentId } });
    if (!row || row.deletedAt) throw new NotFoundException(`Attachment ${attachmentId} not found`);

    if (caller.type === 'client') {
      if (row.visibility !== 'client-visible') throw new ForbiddenException('This file is not shared with clients');
      if (!caller.clientId || row.clientId !== caller.clientId) throw new ForbiddenException('This file does not belong to your account');
    }
    // Operators (any role) may reach operator-only and client-visible files —
    // matches the rest of the app's single-tenant-company / all-operators
    // model (e.g. ClientsController has no per-owner restriction either).

    const buffer = await this.readFromDisk(row.storageKey);
    return { filename: row.filename, mimeType: row.mimeType, buffer };
  }

  async softDelete(attachmentId: string, caller: AuthedRequestUser): Promise<void> {
    const row = await this.prisma.attachment.findUnique({ where: { id: attachmentId } });
    if (!row || row.deletedAt) throw new NotFoundException(`Attachment ${attachmentId} not found`);
    if (caller.type === 'client') throw new ForbiddenException('Clients cannot delete attachments');
    await this.prisma.attachment.update({ where: { id: attachmentId }, data: { deletedAt: new Date() } });
  }

  // ─── Disk I/O ───────────────────────────────────────────────────────

  private decodeBounded(contentBase64: string): Buffer {
    const buffer = Buffer.from(contentBase64, 'base64');
    if (buffer.byteLength === 0) throw new ForbiddenException('Empty file content');
    if (buffer.byteLength > MAX_UPLOAD_BYTES) {
      throw new ForbiddenException(`File exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB upload limit`);
    }
    return buffer;
  }

  private async writeToDisk(id: string, buffer: Buffer): Promise<void> {
    await mkdir(STORAGE_ROOT, { recursive: true });
    await writeFile(join(STORAGE_ROOT, id), buffer);
  }

  private async readFromDisk(storageKey: string): Promise<Buffer> {
    try {
      return await readFile(join(STORAGE_ROOT, storageKey));
    } catch {
      throw new NotFoundException('Stored file is missing');
    }
  }

  private toDto(row: {
    id: string;
    clientId: string | null;
    projectId: string | null;
    contextType: string;
    contextId: string | null;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    visibility: string;
    uploadedBy: string;
    createdAt: Date;
  }): AttachmentDto {
    return {
      id: row.id,
      clientId: row.clientId,
      projectId: row.projectId,
      contextType: row.contextType,
      contextId: row.contextId,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      visibility: row.visibility as AttachmentDto['visibility'],
      uploadedBy: row.uploadedBy,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
