/**
 * WorkspaceAgentsManager — AGENTS.md 专用 CAS-protected service.
 *
 * Atomic dual-slot architecture:
 *  - Two content slots: AGENTS.0.md / AGENTS.1.md
 *  - Two meta slots:    .agents.meta.0.json / .agents.meta.1.json
 *  - One pointer:       .agents.ptr.json → {slot: 0|1}
 *
 * Write always targets the INACTIVE slot; only the pointer rename is the
 * atomic commit. Any failure before pointer rename leaves the active slot
 * fully intact (complete old content + complete old etag). After pointer
 * rename, the new slot is active with complete new content + new etag.
 *
 * Crash at any point recovers to EITHER complete-old OR complete-new state.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  WorkspaceAgentsContentSchema,
  createWorkspaceAgentsFailure,
  createWorkspaceAgentsCASConflict,
  type WorkspaceAgentsView,
  type WorkspaceAgentsMutationResult,
} from '../runtime/WorkspaceAgentsContract.js';
import { hashWorkspaceAgentsContent } from './WorkspaceAgentsHash.js';

const MAX_ALLOWED_VERSION = Number.MAX_SAFE_INTEGER - 1;

interface AgentsMeta {
  version: number;
  contentHash: string;
  updatedAt: number;
  contentMtimeMs?: number;
  contentSize?: number;
}

interface PtrFile {
  slot: 0 | 1;
}

interface SlotScanResult {
  slot: 0 | 1;
  status: 'valid' | 'invalid' | 'absent';
  content: string;
  version: number;
  contentHash: string;
}

export class WorkspaceAgentsManager {
  private readonly contentPaths: [string, string];
  private readonly metaPaths: [string, string];
  private readonly lockPath: string;
  private readonly ptrPath: string;
  /** Canonical realpath of trustedBase — used as a containment anchor for
   *  all pre-mkdir ancestor checks to prevent TOCTOU junction traversal. */
  private readonly canonicalTrustedBase: string;
  // WorkspaceRoot is computed in constructor and reserved for future containment checks
  readonly workspaceRoot: string;
  readonly projectId: string;

  /**
   * @param trustedBase  Trusted base directory (e.g., Electron userData)
   * @param projectId   Validated project identifier — directory is derived as
   *                     `<trustedBase>/projects/<projectId>` to isolate projects.
   */
  constructor(trustedBase: string, projectId: string) {
    if (!projectId || typeof projectId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(projectId)) {
      throw new Error('Invalid projectId');
    }
    this.projectId = projectId;
    // Reject if trustedBase itself is a symlink or junction
    try {
      const baseStat = fs.lstatSync(trustedBase);
      if (baseStat.isSymbolicLink() || this.isJunction(baseStat, trustedBase)) {
        throw new Error('Workspace root must not be a junction or symlink');
      }
      this.canonicalTrustedBase = fs.realpathSync(trustedBase);
    } catch (err) {
      if (err instanceof Error && err.message.includes('Workspace root')) throw err;
      throw new Error(`Trusted base path invalid: ${String(err)}`, { cause: err });
    }
    const dataDir = path.join(trustedBase, 'projects', projectId);

    let resolved: string;
    try {
      if (fs.existsSync(dataDir)) {
        resolved = fs.realpathSync(dataDir);
        const stat = fs.lstatSync(dataDir);
        if (stat.isSymbolicLink() || this.isJunction(stat, dataDir)) {
          throw new Error('Workspace root must not be a junction or symlink');
        }
      } else {
        let ancestor = dataDir;
        const missing: string[] = [];
        while (!fs.existsSync(ancestor)) {
          const parent = path.dirname(ancestor);
          if (parent === ancestor) break;
          missing.unshift(path.basename(ancestor));
          ancestor = parent;
        }
        // Ancestor itself must pass lstat + junction/symlink check —
        // realpathSync alone would resolve through a junction target,
        // silently bypassing the containment check.
        const ancestorStat = fs.lstatSync(ancestor);
        if (ancestorStat.isSymbolicLink() || this.isJunction(ancestorStat, ancestor)) {
          throw new Error('Workspace root must not be a junction or symlink');
        }
        resolved = path.join(fs.realpathSync(ancestor), ...missing);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('Workspace root')) throw err;
      // Path resolution failure → fail closed: do not fall back to raw path
      throw new Error(`Workspace root path resolution failed: ${String(err)}`, { cause: err });
    }
    this.workspaceRoot = resolved;

    // Slot paths
    this.contentPaths = [
      path.join(resolved, 'AGENTS.0.md'),
      path.join(resolved, 'AGENTS.1.md'),
    ];
    this.metaPaths = [
      path.join(resolved, '.agents.meta.0.json'),
      path.join(resolved, '.agents.meta.1.json'),
    ];
    this.lockPath = path.join(resolved, '.agents.lock');
    this.ptrPath = path.join(resolved, '.agents.ptr.json');
  }

  /** Detect Windows junction/reparse point */
  private isJunction(_stat: fs.Stats, filePath: string): boolean {
    if (process.platform !== 'win32') return false;
    // On Windows, junctions report as directories but have reparse attribute
    // We detect by checking if realpath differs from the nominal path
    try {
      const real = fs.realpathSync(filePath);
      const normalized = path.resolve(filePath);
      return real !== normalized;
    } catch {
      return false;
    }
  }

  /** Verify workspaceRoot still exists, is not a symlink/junction, realpath
   *  matches the canonical path, and the resolved path is contained within
   *  canonicalTrustedBase.  Called before every read/write and after mkdir to
   *  close TOCTOU windows. */
  private verifyWorkspaceRoot(): boolean {
    try {
      const stat = fs.lstatSync(this.workspaceRoot);
      if (stat.isSymbolicLink() || this.isJunction(stat, this.workspaceRoot)) {
        return false;
      }
      const real = fs.realpathSync(this.workspaceRoot);
      if (real !== this.workspaceRoot) return false;
      // Must be contained within canonicalTrustedBase
      const sep = path.sep;
      if (!real.startsWith(this.canonicalTrustedBase + sep) && real !== this.canonicalTrustedBase) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Pre-mkdir containment check: walk from workspaceRoot up to the nearest
   *  existing ancestor, verify it is not a symlink/junction, and that its
   *  realpath is within canonicalTrustedBase.  Must pass BEFORE any mkdir to
   *  prevent creating directories inside a junction target. */
  private verifyAncestorContainment(): boolean {
    try {
      let ancestor = this.workspaceRoot;
      while (!fs.existsSync(ancestor)) {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) return false; // hit root
        ancestor = parent;
      }
      const stat = fs.lstatSync(ancestor);
      if (stat.isSymbolicLink() || this.isJunction(stat, ancestor)) {
        return false;
      }
      const real = fs.realpathSync(ancestor);
      const sep = path.sep;
      if (!real.startsWith(this.canonicalTrustedBase + sep) && real !== this.canonicalTrustedBase) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  // ─── Read ──────────────────────────────────────────────────

  read(): WorkspaceAgentsView {
    // If workspaceRoot exists, verify it's still canonical (TOCTOU defence)
    try {
      if (fs.existsSync(this.workspaceRoot) && !this.verifyWorkspaceRoot()) {
        return { exists: true, content: '', version: 0, contentHash: '', externalConflict: true, projectId: this.projectId };
      }
    } catch { /* absent workspaceRoot → ok for read */ }

    const results: [SlotScanResult, SlotScanResult] = [
      this.scanSlot(0),
      this.scanSlot(1),
    ];

    const valid = results.filter(r => r.status === 'valid');
    const hasAnyFile = results.some(r => r.status !== 'absent');

    // ── No valid slots ──────────────────────────────────────
    if (valid.length === 0) {
      if (!hasAnyFile) {
        return { exists: false, content: '', version: 0, contentHash: '', projectId: this.projectId };
      }
      // Files exist but neither validates → external conflict
      return { exists: true, content: '', version: 0, contentHash: '', externalConflict: true, projectId: this.projectId };
    }

    // ── Exactly one valid slot ──────────────────────────────
    if (valid.length === 1) {
      const v = valid[0]!;
      return { exists: true, content: v.content, version: v.version, contentHash: v.contentHash, projectId: this.projectId };
    }

    // ── Both slots valid ────────────────────────────────────
    const [a, b] = valid as [SlotScanResult, SlotScanResult];

    // Different versions → highest wins (recovery)
    if (a.version !== b.version) {
      const winner = a.version > b.version ? a : b;
      return { exists: true, content: winner.content, version: winner.version, contentHash: winner.contentHash, projectId: this.projectId };
    }

    // Same version, different hash → fork detected → externalConflict
    if (a.contentHash !== b.contentHash) {
      return { exists: true, content: a.content, version: a.version, contentHash: a.contentHash, externalConflict: true, projectId: this.projectId };
    }

    // Same version, same hash → pick pointer-preferred, or either
    const ptr = this.readPtr();
    if (ptr && valid.some(v => v.slot === ptr.slot)) {
      const preferred = valid.find(v => v.slot === ptr.slot)!;
      return { exists: true, content: preferred.content, version: preferred.version, contentHash: preferred.contentHash, projectId: this.projectId };
    }
    return { exists: true, content: a.content, version: a.version, contentHash: a.contentHash, projectId: this.projectId };
  }

  /** Independently evaluate one slot: content schema → meta → hash → version → mtime/size.
   *
   *  Uses lstatSync (not existsSync) so that EACCES/IO errors are surfaced as
   *  'invalid' rather than silently folded into 'absent'.  Rejects symlinks and
   *  Windows junctions/reparse points on content and meta files. */
  private scanSlot(slot: 0 | 1): SlotScanResult {
    const contentPath = this.contentPaths[slot];
    const metaPath = this.metaPaths[slot];

    // ── Content file — lstat to surface IO errors ────────────
    let contentStat: fs.Stats;
    try {
      contentStat = fs.lstatSync(contentPath);
    } catch (_err: unknown) {
      const err = _err as { code?: string };
      if (err?.code === 'ENOENT') {
        return { slot, status: 'absent', content: '', version: 0, contentHash: '' };
      }
      // EACCES, EIO, etc. → fail-closed (not empty)
      return { slot, status: 'invalid', content: '', version: 0, contentHash: '' };
    }
    // Reject symlinks / junctions on content files
    if (contentStat.isSymbolicLink() || this.isJunction(contentStat, contentPath)) {
      return { slot, status: 'invalid', content: '', version: 0, contentHash: '' };
    }
    if (!contentStat.isFile()) {
      return { slot, status: 'invalid', content: '', version: 0, contentHash: '' };
    }

    // ── Read + validate content ─────────────────────────────
    let content: string;
    try {
      const raw = fs.readFileSync(contentPath, 'utf-8');
      const parsed = WorkspaceAgentsContentSchema.safeParse(raw);
      if (!parsed.success) {
        return { slot, status: 'invalid', content: '', version: 0, contentHash: '' };
      }
      content = raw;
    } catch {
      return { slot, status: 'invalid', content: '', version: 0, contentHash: '' };
    }

    const contentHash = hashWorkspaceAgentsContent(content);

    // ── Meta — lstat to surface IO errors + reject symlinks ─
    try {
      const metaStat = fs.lstatSync(metaPath);
      if (metaStat.isSymbolicLink() || this.isJunction(metaStat, metaPath)) {
        return { slot, status: 'invalid', content, version: 0, contentHash };
      }
    } catch {
      // ENOENT → missing meta (invalid), EACCES/EIO → invalid
      return { slot, status: 'invalid', content, version: 0, contentHash };
    }

    const meta = this.readMeta(metaPath);
    if (!meta) {
      return { slot, status: 'invalid', content, version: 0, contentHash };
    }

    // ── Hash integrity ──────────────────────────────────────
    if (meta.contentHash !== contentHash) {
      return { slot, status: 'invalid', content, version: meta.version, contentHash };
    }

    // ── Version safety ──────────────────────────────────────
    if (!Number.isSafeInteger(meta.version) || meta.version < 0 || meta.version > MAX_ALLOWED_VERSION) {
      return { slot, status: 'invalid', content, version: meta.version, contentHash };
    }

    // ── Mtime/size cross-check (when recorded) ──────────────
    if (meta.contentMtimeMs !== undefined && meta.contentSize !== undefined) {
      try {
        const stat = fs.statSync(contentPath);
        if (stat.mtimeMs !== meta.contentMtimeMs || stat.size !== meta.contentSize) {
          return { slot, status: 'invalid', content, version: meta.version, contentHash };
        }
      } catch {
        // stat failure → slot invalid (disk error or externally removed)
        return { slot, status: 'invalid', content, version: meta.version, contentHash };
      }
    }

    return { slot, status: 'valid', content, version: meta.version, contentHash };
  }

  // ─── Exclusive lock ────────────────────────────────────────

  private acquireLock(): boolean {
    try {
      const dir = path.dirname(this.lockPath);
      if (!fs.existsSync(dir)) {
        // Pre-mkdir: verify nearest existing ancestor is within
        // canonicalTrustedBase and is not a junction.  If workspaceRoot was
        // swapped after construction, this fails BEFORE any directory is created.
        if (!this.verifyAncestorContainment()) return false;
        fs.mkdirSync(dir, { recursive: true });
        // Post-mkdir: verify the newly-created workspaceRoot is canonical
        if (!this.verifyWorkspaceRoot()) return false;
      } else if (!this.verifyWorkspaceRoot()) {
        // Directory already exists but may have been replaced with a junction
        // after construction. Verify workspaceRoot is still canonical.
        return false;
      }
      fs.writeFileSync(this.lockPath, String(process.pid), { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
      return true;
    } catch { return false; }
  }

  private releaseLock(): void {
    try { if (fs.existsSync(this.lockPath)) fs.unlinkSync(this.lockPath); } catch { /* best-effort */ }
  }

  // ─── Write (CAS) ───────────────────────────────────────────

  write(content: string, expectedVersion: number): WorkspaceAgentsMutationResult {
    if (!this.acquireLock()) return createWorkspaceAgentsFailure('io_error');
    try {
    const contentCheck = WorkspaceAgentsContentSchema.safeParse(content);
    if (!contentCheck.success) {
      return createWorkspaceAgentsFailure('content_invalid');
    }

    const current = this.read();

    // Version-overflow check from stored meta — independent of read()'s
    // normalization, since read() may squash an overflowed slot to 'invalid' and
    // lose the version information. Checks both slots.
    for (const slot of [0, 1] as const) {
      const sm = this.readMeta(this.metaPaths[slot]);
      if (sm && sm.version >= MAX_ALLOWED_VERSION) {
        return createWorkspaceAgentsFailure('io_error');
      }
    }

    if (current.externalConflict) {
      return { success: false, code: 'external_conflict' as const };
    }

    if (expectedVersion !== current.version) {
      return createWorkspaceAgentsCASConflict(current.version, current.contentHash);
    }

    const newHash = hashWorkspaceAgentsContent(content);
    const newVersion = current.version + 1;
    const meta: AgentsMeta = {
      version: newVersion,
      contentHash: newHash,
      updatedAt: Date.now(),
    };

    // Read current pointer to find inactive slot
    const ptr = this.readPtr();
    const activeSlot = ptr?.slot ?? 0;
    const inactiveSlot = activeSlot === 0 ? 1 : 0;
    const targetContentPath = this.contentPaths[inactiveSlot];
    const targetMetaPath = this.metaPaths[inactiveSlot];

    // Ensure directory exists — with pre-mkdir containment + post-mkdir verify
    const dir = path.dirname(targetContentPath);
    if (!fs.existsSync(dir)) {
      // Pre-mkdir: verify nearest existing ancestor is canonical.
      // Prevents creating directories inside a junction target swapped
      // between construction and now.
      if (!this.verifyAncestorContainment()) {
        try { this.releaseLock(); } catch { /* best-effort */ }
        return createWorkspaceAgentsFailure('io_error');
      }
      fs.mkdirSync(dir, { recursive: true });
      // Post-mkdir: verify the newly-created directory is canonical
      if (!this.verifyWorkspaceRoot()) {
        try { this.releaseLock(); } catch { /* best-effort */ }
        return createWorkspaceAgentsFailure('io_error');
      }
    }

    // ── Phase A: write content to inactive slot (temp → fsync → rename) ─
    const contentTmp = `${targetContentPath}.${randomUUID()}.tmp`;
    try {
      if (!this.verifyWorkspaceRoot()) {
        return createWorkspaceAgentsFailure('io_error');
      }
      fs.writeFileSync(contentTmp, content, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
      const cFd = fs.openSync(contentTmp, 'r+');
      try { fs.fsyncSync(cFd); } finally { fs.closeSync(cFd); }
      fs.renameSync(contentTmp, targetContentPath);
    } catch {
      try { if (fs.existsSync(contentTmp)) fs.unlinkSync(contentTmp); } catch { /* ignore */ }
      return createWorkspaceAgentsFailure('io_error');
    }

    // Capture mtime/size of newly-written content, then build the final meta
    // once (with mtime/size).  This avoids the old two-phase write where the
    // second writeFileSync(targetMetaPath, …) was an in-place overwrite without
    // fsync/rename — which could leave a truncated meta on crash.
    try {
      const stat = fs.statSync(targetContentPath);
      meta.contentMtimeMs = stat.mtimeMs;
      meta.contentSize = stat.size;
    } catch { /* non-critical — meta will lack mtime/size cross-check fields */ }

    const finalMetaJson = JSON.stringify(meta, null, 2) + '\n';
    const metaTmp = `${targetMetaPath}.${randomUUID()}.tmp`;
    try {
      if (!this.verifyWorkspaceRoot()) {
        return createWorkspaceAgentsFailure('io_error');
      }
      fs.writeFileSync(metaTmp, finalMetaJson, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
      const mFd = fs.openSync(metaTmp, 'r+');
      try { fs.fsyncSync(mFd); } finally { fs.closeSync(mFd); }
      fs.renameSync(metaTmp, targetMetaPath);
    } catch {
      try { if (fs.existsSync(metaTmp)) fs.unlinkSync(metaTmp); } catch { /* ignore */ }
      return createWorkspaceAgentsFailure('io_error');
    }

    // ── Phase B: ATOMIC COMMIT — pointer temp → fsync → rename ──
    // This is the ONLY commit point. If it fails, old slot is still active
    // with complete old content + meta intact.
    const newPtr: PtrFile = { slot: inactiveSlot as 0 | 1 };
    const ptrTmp = `${this.ptrPath}.${randomUUID()}.tmp`;

    try {
      if (!this.verifyWorkspaceRoot()) {
        return createWorkspaceAgentsFailure('io_error');
      }
      fs.writeFileSync(ptrTmp, JSON.stringify(newPtr), { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
      const pFd = fs.openSync(ptrTmp, 'r+');
      try { fs.fsyncSync(pFd); } finally { fs.closeSync(pFd); }
      fs.renameSync(ptrTmp, this.ptrPath);

      if (process.platform !== 'win32') {
        const dirFd = fs.openSync(dir, 'r');
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      }
    } catch {
      try { if (fs.existsSync(ptrTmp)) fs.unlinkSync(ptrTmp); } catch { /* ignore */ }
      // Pointer NOT updated → old slot still active → complete old state intact
      return createWorkspaceAgentsFailure('io_error');
    }

    return {
      success: true,
      code: 'saved' as const,
      version: newVersion,
      contentHash: newHash,
    };
    } finally {
      this.releaseLock();
    }
  }

  // ─── Pointer file ──────────────────────────────────────────

  private readPtr(): PtrFile | null {
    try {
      if (!fs.existsSync(this.ptrPath)) return null;
      const raw = fs.readFileSync(this.ptrPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (typeof parsed?.slot === 'number' && (parsed.slot === 0 || parsed.slot === 1)) {
        return { slot: parsed.slot };
      }
      return null;
    } catch {
      return null;
    }
  }

  // ─── Meta sidecar ──────────────────────────────────────────

  private readMeta(metaPath: string): AgentsMeta | null {
    try {
      if (!fs.existsSync(metaPath)) return null;
      const raw = fs.readFileSync(metaPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (
        typeof parsed?.version === 'number' &&
        typeof parsed?.contentHash === 'string'
      ) {
        return {
          version: parsed.version,
          contentHash: parsed.contentHash,
          updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
          contentMtimeMs: typeof parsed.contentMtimeMs === 'number' ? parsed.contentMtimeMs : undefined,
          contentSize: typeof parsed.contentSize === 'number' ? parsed.contentSize : undefined,
        };
      }
      return null;
    } catch {
      return null;
    }
  }
}
