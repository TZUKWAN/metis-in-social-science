/**
 * AutoUpdaterService — background update download & install for unsigned builds.
 *
 * electron-updater on Windows NSIS does not require a signed installer when
 * verifyUpdateCodeSignature is false (set in package.json build.win). This
 * service wraps autoUpdater with a small surface: on startup it checks for
 * updates in the background and, when one is available, downloads it silently
 * and notifies the renderer; the user chooses when to quit-and-install (or we
 * can install on quit). All failures degrade to "check failed" and never
 * block startup.
 */

import { EventEmitter } from 'node:events';

export type AutoUpdateEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string }
  | { type: 'not-available' }
  | { type: 'downloading'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string };

/**
 * Thin wrapper around electron-updater so tests can inject a fake updater.
 * `updater` is expected to expose checkForUpdatesAndNotify / on / downloadUpdate
 * / quitAndInstall; when omitted we lazily import electron-updater at runtime
 * (main process only).
 */
export interface AutoUpdaterLike {
  on(event: string, listener: (...args: never[]) => void): unknown;
  checkForUpdatesAndNotify(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
}

export class AutoUpdaterService extends EventEmitter {
  #updater: AutoUpdaterLike | null = null;
  #downloaded = false;

  constructor(private readonly updaterFactory?: () => AutoUpdaterLike) {
    super();
  }

  private getUpdater(): AutoUpdaterLike | null {
    if (this.#updater) return this.#updater;
    try {
      if (this.updaterFactory) {
        this.#updater = this.updaterFactory();
      } else {
        // electron-updater is a CommonJS module; require it in the main process.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { autoUpdater } = require('electron-updater') as { autoUpdater: AutoUpdaterLike };
        this.#updater = autoUpdater;
      }
      return this.#updater;
    } catch {
      return null;
    }
  }

  /** Start listening and check for updates in the background. */
  init(): void {
    const updater = this.getUpdater();
    if (!updater) {
      // Never emit the special 'error' event (throws when unlistened); use the
      // unified 'event' channel.
      this.emit('event', { type: 'error', message: 'electron-updater unavailable' });
      return;
    }
    updater.on('checking-for-update', () => this.emit('event', { type: 'checking' }));
    updater.on('update-available', (info: { version?: string }) => {
      this.emit('event', { type: 'available', version: info?.version ?? 'unknown' });
    });
    updater.on('update-not-available', () => this.emit('event', { type: 'not-available' }));
    updater.on('download-progress', (progress: { percent?: number }) => {
      this.emit('event', { type: 'downloading', percent: progress?.percent ?? 0 });
    });
    updater.on('update-downloaded', (info: { version?: string }) => {
      this.#downloaded = true;
      this.emit('event', { type: 'downloaded', version: info?.version ?? 'unknown' });
    });
    updater.on('error', (err: Error) => {
      this.emit('event', { type: 'error', message: err?.message ?? 'update error' });
    });

    // Background check; never awaited (must not block startup).
    void updater.checkForUpdatesAndNotify().catch(() => {
      this.emit('event', { type: 'error', message: 'update check failed' });
    });
  }

  /** Download the update in the background (safe to call after available). */
  async download(): Promise<void> {
    const updater = this.getUpdater();
    if (!updater || this.#downloaded) return;
    await updater.downloadUpdate().catch(() => { /* handled by events */ });
  }

  /** Install the downloaded update and restart the app. */
  quitAndInstall(): void {
    this.getUpdater()?.quitAndInstall();
  }
}
