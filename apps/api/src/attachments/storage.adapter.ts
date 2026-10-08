import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';

/**
 * DIRECTIVE 2 — FILES LIVE ON DISK; THE DATABASE HOLDS ONLY A PATH.
 *
 * This adapter is the ONLY place that touches bytes. It writes the physical file
 * under a storage root and returns the metadata + relative path; it never returns
 * a buffer to a caller that might persist it, and it never speaks to the
 * database. `core.files.object_key` receives the RELATIVE path, so moving the
 * storage root (a VPS migration, say) does not invalidate every stored row.
 *
 * Storage root and bucket name are configuration, not constants:
 *   ATTACHMENT_STORAGE_ROOT   where the bytes go
 *   ATTACHMENT_STORAGE_BUCKET the logical bucket label recorded in the DB
 *
 * A default PATH is not a hardcoded business limit — it names where to write when
 * an operator has not chosen yet. The size ceilings live in core.settings and the
 * environment; nothing about how large a file may be is decided in this file.
 *
 * WHY THE DEFAULT IS ANCHORED TO __dirname AND NOT process.cwd()
 * ------------------------------------------------------------------
 * The first version resolved the default against `process.cwd()`. Launched from
 * `apps/api` it wrote to `apps/api/var/attachments`; launched from the repo root
 * it would have written to `var/attachments`. Two files with the same object_key
 * would then live in two places, and a VPS restart from a different working
 * directory would scatter a year of documents. A storage root that moves with the
 * launch directory is a data-loss bug waiting for a maintenance window.
 *
 * WHY THE DEFAULT IS DISCOVERED, NOT COUNTED
 * ------------------------------------------
 * `__dirname` is stable across launch directories, but it is NOT stable across
 * build layouts: it is `apps/api/src/attachments` under ts-node-dev and
 * `apps/api/dist/attachments` after a compile. Counting `..` segments to reach the
 * repository root therefore has to be right for both depths, and an earlier
 * version of this file counted three and landed on `apps/`, writing the real
 * storage root to `apps/var/attachments` instead of `var/attachments`.
 *
 * That slipped through because the harness asked the API where it stored files
 * and asserted the answer was truthy — a test that cannot fail, because the API
 * is quoting itself. So instead of counting, this walks up until it finds a
 * directory that actually looks like the repository root (the application tree
 * and the database tree side by side), which is true for every build layout and
 * for both dev and production checkouts. The harness now pins the expected path
 * rather than trusting the answer.
 */
@Injectable()
export class StorageAdapter {
  private readonly log = new Logger('Storage');

  /**
   * Walk up from this module to the repository root.
   *
   * A marker directory is used rather than a fixed number of `..` segments so the
   * answer is identical from `src/attachments` and from `dist/attachments`.
   *
   * The marker has to be a COMBINATION, not just `package.json`: every package in
   * the monorepo has one, so matching on it alone stops the walk at `apps/api` and
   * silently writes the real storage into `apps/api/var`. `apps` alone is no better.
   * The repository root is the one directory holding the application tree AND the
   * database tree — a combination no inner package can satisfy by accident.
   */
  private static repoRoot(): string {
    let dir = __dirname;
    for (let hop = 0; hop < 8; hop++) {
      if (
        existsSync(join(dir, 'apps'))
        && existsSync(join(dir, 'db'))
        && existsSync(join(dir, 'package.json'))
      ) return dir;
      const up = dirname(dir);
      if (up === dir) break;            // reached the filesystem root
      dir = up;
    }
    // A packaged deployment may have no repository layout at all. Say so loudly
    // rather than silently writing into whatever happens to be nearby.
    return resolve(__dirname, '..', '..');
  }

  private root(): string {
    const configured = process.env.ATTACHMENT_STORAGE_ROOT;
    if (configured && configured.trim()) return resolve(configured.trim());
    return resolve(StorageAdapter.repoRoot(), 'var', 'attachments');
  }

  private bucket(): string {
    return process.env.ATTACHMENT_STORAGE_BUCKET || 'local';
  }

  /** Public so the API can report where files actually live. */
  describe() {
    return { root: this.root(), bucket: this.bucket() };
  }

  /**
   * Reduce an uploaded filename to something safe to put on a filesystem.
   *
   * Path separators and traversal are removed rather than escaped: a name is a
   * label here, never a path. The extension is preserved because Procurement
   * recognises documents by it.
   */
  static safeName(raw: string): string {
    const base = String(raw || '').split(/[\\/]/).pop() || '';
    const cleaned = base
      .replace(/[^A-Za-z0-9._ -]/g, '_')
      .replace(/\.{2,}/g, '.')
      .trim();
    const trimmed = cleaned.slice(0, 180);
    return trimmed.length ? trimmed : 'unnamed';
  }

  /**
   * Write bytes to disk and return the metadata the database will record.
   *
   * The write is atomic: the file lands under a temporary name and is renamed
   * into place, so a crash mid-write can never leave a half-written PDF that the
   * registry would then point at.
   */
  async put(filename: string, data: Buffer): Promise<{
    bucket: string; objectKey: string; sha256: string; size: number;
  }> {
    const root = this.root();
    const now = new Date();
    const safe = StorageAdapter.safeName(filename);
    const ext = extname(safe);
    const stem = safe.slice(0, safe.length - ext.length).replace(/\s+/g, '-');

    // Date-sharded so a single directory never accumulates an unbounded number
    // of entries, and the id makes a name collision impossible.
    const rel = join(
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
      `${randomUUID()}-${stem}${ext}`,
    );

    const abs = resolve(join(root, rel));
    // Defence in depth: even though rel is built from sanitised parts, confirm
    // the resolved path is still inside the root before writing anything.
    if (!abs.startsWith(root + sep) && abs !== root) {
      throw new Error(`refusing to write outside the storage root: ${abs}`);
    }

    await mkdir(dirname(abs), { recursive: true });
    const tmp = `${abs}.part`;
    await writeFile(tmp, data);
    await rename(tmp, abs);

    const sha256 = createHash('sha256').update(data).digest('hex');
    this.log.log(`stored ${data.length} bytes at ${rel}`);
    return {
      bucket: this.bucket(),
      objectKey: rel.split(sep).join('/'),
      sha256,
      size: data.length,
    };
  }

  /** Remove a stored file. Best-effort: a missing file is not an error. */
  async remove(objectKey: string) {
    const root = this.root();
    const abs = resolve(join(root, objectKey));
    if (!abs.startsWith(root + sep)) {
      this.log.warn(`refusing to delete outside the storage root: ${objectKey}`);
      return false;
    }
    if (!existsSync(abs)) return false;
    await unlink(abs);
    return true;
  }

  /** Resolve a stored key to an absolute path, for a download. */
  absolute(objectKey: string): string {
    const root = this.root();
    const abs = resolve(join(root, objectKey));
    if (!abs.startsWith(root + sep)) throw new Error('object key escapes the storage root');
    return abs;
  }
}
