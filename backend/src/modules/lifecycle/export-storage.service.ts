/**
 * ExportStorageService — where an assembled export actually lives.
 *
 * `ExportRequest.storageKey` is a locator; something has to be behind it. This
 * service writes the generated bundle to a directory on the backend host and
 * reads it back on download, so "the export is scoped and expiring" is a
 * property of real bytes rather than a field that says it is.
 *
 * Scope discipline:
 * - A `storageKey` is always a single generated filename. {@link resolveRoot}
 *   rejects anything that is not, so a stored value can never be used to read
 *   a file outside the export directory.
 * - The key is derived from the export's own id, so two exports cannot collide
 *   and one client's download can never address another's file. The row's
 *   scope check is the primary control; this is the second one.
 *
 * No new dependency is needed: `node:fs/promises` and `node:path` are enough
 * for one file per export at this size. A deployment that outgrows the local
 * filesystem points `CAILYX_EXPORT_DIR` at a mounted volume.
 *
 * @module export-storage.service
 */

import { Injectable, Logger } from '@nestjs/common';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/** A single filename with no separators — the only shape a storage key may take. */
const SAFE_KEY = /^[A-Za-z0-9._-]+$/;

@Injectable()
export class ExportStorageService {
  private readonly logger = new Logger(ExportStorageService.name);
  private readonly root: string;

  constructor() {
    this.root = process.env.CAILYX_EXPORT_DIR ?? path.join(tmpdir(), 'cailyx-exports');
  }

  /** The directory exports are written under. Reported so a deployment can be checked. */
  directory(): string {
    return this.root;
  }

  /**
   * Write an export's payload.
   *
   * @throws Error when the file cannot be written — the caller marks the
   *         export `failed` and records the reason. An export that silently
   *         reports `ready` with no file behind it is worse than one that
   *         failed, because the failure would only surface at download time.
   */
  async write(exportId: string, content: string): Promise<{ storageKey: string; sizeBytes: number }> {
    await mkdir(this.root, { recursive: true });
    const storageKey = `${exportId}.json`;
    const target = this.resolveRoot(storageKey);
    await writeFile(target, content, 'utf8');
    const info = await stat(target);
    return { storageKey, sizeBytes: info.size };
  }

  /**
   * Read an export's payload.
   * @throws Error the key is malformed or the file is missing (e.g. the host's
   *         temp directory was cleared, or a different instance served the
   *         request). The caller reports that rather than an empty body.
   */
  async read(storageKey: string): Promise<string> {
    return readFile(this.resolveRoot(storageKey), 'utf8');
  }

  /** Whether the payload is still on disk. Used to give an honest 410 rather than an empty 200. */
  async exists(storageKey: string): Promise<boolean> {
    try {
      const info = await stat(this.resolveRoot(storageKey));
      return info.isFile();
    } catch {
      return false;
    }
  }

  /**
   * Remove an expired export's payload. Best-effort: a failure to unlink is
   * logged, not thrown, because the export row is already marked expired and
   * the download path refuses on `expiresAt` regardless of whether the bytes
   * are still on disk.
   */
  async remove(storageKey: string): Promise<void> {
    try {
      await rm(this.resolveRoot(storageKey), { force: true });
    } catch (error) {
      this.logger.warn(`Could not remove export payload ${storageKey}: ${(error as Error).message}`);
    }
  }

  /**
   * Resolve a storage key to an absolute path inside the export directory.
   *
   * Rejects anything that is not a bare filename. `path.resolve` plus a
   * prefix check is the second line: even if the pattern were loosened, a key
   * that escaped the root would still be refused rather than read.
   */
  private resolveRoot(storageKey: string): string {
    if (!SAFE_KEY.test(storageKey)) {
      throw new Error(`Refusing to use "${storageKey}" as an export storage key: it is not a bare filename`);
    }
    const target = path.resolve(this.root, storageKey);
    const rootWithSeparator = path.resolve(this.root) + path.sep;
    if (!target.startsWith(rootWithSeparator)) {
      throw new Error(`Refusing to read outside the export directory: ${storageKey}`);
    }
    return target;
  }
}
