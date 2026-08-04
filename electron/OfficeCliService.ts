/**
 * OfficeCliService — wraps the external `officecli` binary (Apache-2.0,
 * https://github.com/iOfficeAI/OfficeCli) for native Word/PPT/Excel editing.
 *
 * The binary is invoked as a child process; this service keeps it out of the
 * application bundle (users install officecli separately — option A). All
 * commands support `--json` for structured output. Long-running watch servers
 * are tracked per document so they can be torn down on close/quit.
 */

import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

/** One entry per document currently held open (resident mode) or being watched. */
interface ActiveDocument {
  filePath: string;
  watchProcess?: ChildProcessWithoutNullStreams;
  watchPort?: number;
}

export interface OfficeCliResult {
  success: boolean;
  data?: unknown;
  message?: string;
  error?: string;
}

export class OfficeCliService {
  private readonly active = new Map<string, ActiveDocument>();

  /** Detect whether the officecli binary is on PATH (or at a known location). */
  detect(): { available: boolean; binary: string; version?: string } {
    const binary = this.resolveBinary();
    if (!binary) return { available: false, binary: '' };
    try {
      const result = spawnSync(binary, ['--version'], { encoding: 'utf-8', timeout: 8000 });
      if (result.status !== 0) return { available: false, binary };
      const version = (result.stdout || '').trim().split('\n')[0]?.trim();
      return { available: true, binary, version };
    } catch {
      return { available: false, binary };
    }
  }

  /** Locate the binary: PATH first, then the per-user install dir on Windows. */
  private resolveBinary(): string {
    // On Windows the per-user installer places it under %LOCALAPPDATA%\OfficeCli.
    if (process.platform === 'win32') {
      const local = path.join(os.homedir(), 'AppData', 'Local', 'OfficeCli', 'officecli.exe');
      if (fs.existsSync(local)) return local;
    }
    return 'officecli';
  }

  /**
   * Run a one-shot officecli command and return the parsed JSON result.
   * The command array excludes the leading `officecli` token.
   */
  async exec(args: string[]): Promise<OfficeCliResult> {
    const binary = this.resolveBinary();
    return new Promise((resolve) => {
      const options: SpawnOptions = { windowsHide: true, cwd: os.tmpdir() };
      const child = spawn(binary, [...args, '--json'], options) as ChildProcessWithoutNullStreams;
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer | string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: Buffer | string) => { stderr += chunk; });
      child.on('error', (err) => resolve({ success: false, error: err.message }));
      child.on('close', (code) => {
        if (code !== 0 && !stdout) {
          resolve({ success: false, error: stderr.trim() || `officecli exited ${code}` });
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as { success?: boolean; data?: unknown; message?: string };
          resolve({
            success: parsed.success !== false,
            data: parsed.data,
            message: parsed.message,
            error: parsed.success === false ? parsed.message : undefined,
          });
        } catch {
          // Non-JSON output (e.g. a created file path) — treat stdout as data.
          resolve({ success: code === 0, data: stdout.trim(), error: code !== 0 ? stderr.trim() : undefined });
        }
      });
    });
  }

  /** Create a new document (type inferred from extension) and keep it open. */
  async create(filePath: string): Promise<OfficeCliResult> {
    const result = await this.exec(['create', filePath]);
    if (result.success) this.active.set(filePath, { filePath });
    return result;
  }

  /** Open an existing document in resident mode for faster subsequent edits. */
  async open(filePath: string): Promise<OfficeCliResult> {
    const result = await this.exec(['open', filePath]);
    if (result.success && !this.active.has(filePath)) this.active.set(filePath, { filePath });
    return result;
  }

  /** Add an element (paragraph/table/shape/...) with structured properties. */
  async add(filePath: string, parent: string, type: string, props: Record<string, string>): Promise<OfficeCliResult> {
    const args = ['add', filePath, parent, '--type', type];
    for (const [key, value] of Object.entries(props)) {
      args.push('--prop', `${key}=${value}`);
    }
    return this.exec(args);
  }

  /** Modify an element at a path with structured properties. */
  async set(filePath: string, nodePath: string, props: Record<string, string>): Promise<OfficeCliResult> {
    const args = ['set', filePath, nodePath];
    for (const [key, value] of Object.entries(props)) {
      args.push('--prop', `${key}=${value}`);
    }
    return this.exec(args);
  }

  /** Query elements with a CSS-like selector; returns structured nodes. */
  async query(filePath: string, selector: string): Promise<OfficeCliResult> {
    return this.exec(['query', filePath, selector]);
  }

  /** Get a node by path (default root) with its children/properties. */
  async get(filePath: string, nodePath = '/'): Promise<OfficeCliResult> {
    return this.exec(['get', filePath, nodePath]);
  }

  /** Remove an element at a path. */
  async remove(filePath: string, nodePath: string): Promise<OfficeCliResult> {
    return this.exec(['remove', filePath, nodePath]);
  }

  /** Render the document to a self-contained HTML string. */
  async renderHtml(filePath: string): Promise<OfficeCliResult> {
    return this.exec(['view', filePath, 'html']);
  }

  /** Render the document outline (structured summary). */
  async outline(filePath: string): Promise<OfficeCliResult> {
    return this.exec(['view', filePath, 'outline']);
  }

  /**
   * Start a live-preview watch server for a document. Resolves with the local
   * URL the renderer should load in a webview. Subsequent edits auto-refresh.
   */
  async startWatch(filePath: string): Promise<OfficeCliResult & { url?: string; port?: number }> {
    const existing = this.active.get(filePath);
    if (existing?.watchProcess && existing.watchPort) {
      return { success: true, url: `http://localhost:${existing.watchPort}`, port: existing.watchPort };
    }
    const binary = this.resolveBinary();
    return new Promise((resolve) => {
      const options: SpawnOptions = { windowsHide: true, cwd: path.dirname(filePath) || os.tmpdir() };
      const child = spawn(binary, ['watch', filePath], options) as ChildProcessWithoutNullStreams;
      let resolved = false;
      const settle = (result: OfficeCliResult & { url?: string; port?: number }) => {
        if (resolved) return;
        resolved = true;
        resolve(result);
      };
      // The watch server prints its URL on the first stdout/stderr line.
      const detect = (text: string) => {
        const match = text.match(/https?:\/\/localhost:(\d+)/);
        if (match) {
          const port = parseInt(match[1], 10);
          this.active.set(filePath, { filePath, watchProcess: child, watchPort: port });
          settle({ success: true, url: `http://localhost:${port}`, port });
        }
      };
      child.stdout.on('data', (chunk: Buffer | string) => detect(String(chunk)));
      child.stderr.on('data', (chunk: Buffer | string) => detect(String(chunk)));
      child.on('error', (err) => settle({ success: false, error: err.message }));
      child.on('close', () => {
        const entry = this.active.get(filePath);
        if (entry) this.active.delete(filePath);
        settle({ success: Boolean(entry), error: entry ? undefined : 'watch failed to start' });
      });
      // Timeout fallback: if no URL within 8s, fail.
      setTimeout(() => settle({ success: false, error: 'watch did not advertise a URL' }), 8000);
    });
  }

  /** Stop the watch server for a document (keeps the file). */
  async stopWatch(filePath: string): Promise<OfficeCliResult> {
    const entry = this.active.get(filePath);
    if (!entry?.watchProcess) return { success: true, message: 'no watch running' };
    try {
      entry.watchProcess.kill();
    } catch { /* best-effort */ }
    this.active.delete(filePath);
    return { success: true };
  }

  /** Flush and close the resident document (also stops watch if running). */
  async close(filePath: string): Promise<OfficeCliResult> {
    const entry = this.active.get(filePath);
    if (entry?.watchProcess) {
      try { entry.watchProcess.kill(); } catch { /* best-effort */ }
    }
    this.active.delete(filePath);
    return this.exec(['close', filePath]);
  }

  /** Tear down everything (used on app quit). */
  shutdown(): void {
    for (const [, entry] of this.active) {
      if (entry.watchProcess) {
        try { entry.watchProcess.kill(); } catch { /* best-effort */ }
      }
    }
    this.active.clear();
  }
}

// ── Geometry helpers (PPT non-overlap enforcement) ──────────

interface Rect { x: number; y: number; w: number; h: number; }

/** Parse a length string ("1cm", "72pt", "1in") to points (pt). */
function lengthToPt(value: string | undefined): number {
  if (!value) return 0;
  const m = value.match(/^([\d.]+)\s*(cm|pt|in|emu|px)?/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = (m[2] ?? 'pt').toLowerCase();
  switch (unit) {
    case 'cm': return n * 28.346;
    case 'in': return n * 72;
    case 'emu': return n / 12700;
    case 'px': return n * 0.75;
    default: return n;
  }
}

/** Check if two rectangles overlap. */
function rectsOverlap(a: Rect, b: Rect): boolean {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

/** Find a non-overlapping position for a new shape on a slide. Returns {x,y}
 *  in pt, nudged downward until no existing rect overlaps. */
export function findNonOverlappingPosition(
  existingShapes: Array<{ x?: string; y?: string; width?: string; height?: string }>,
  proposed: { x: number; y: number; w: number; h: number },
): { x: number; y: number } {
  const rects: Rect[] = existingShapes.map((s) => ({
    x: lengthToPt(s.x),
    y: lengthToPt(s.y),
    w: lengthToPt(s.width),
    h: lengthToPt(s.height),
  }));
  let candidate = { ...proposed };
  // Nudge down in 10pt increments until clear (cap at 500pt to avoid infinite loop).
  for (let i = 0; i < 50; i += 1) {
    const overlaps = rects.some((r) => rectsOverlap(candidate, r));
    if (!overlaps) break;
    candidate = { ...candidate, y: candidate.y + 10 };
  }
  return { x: candidate.x, y: candidate.y };
}

/** Module-level singleton, wired into the main process. */
let officeCliService: OfficeCliService | null = null;

export function getOfficeCliService(): OfficeCliService {
  if (!officeCliService) officeCliService = new OfficeCliService();
  return officeCliService;
}
