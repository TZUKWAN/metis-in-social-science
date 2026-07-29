/**
 * PDF downloader helpers for fetching open-access PDFs.
 *
 * Runs in Node.js (main process). Uses Node's built-in http/https modules
 * so it has no extra native dependencies.
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https:') ? https : http;
    const file = fs.createWriteStream(dest);
    const req = protocol.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        const redirectUrl = new URL(res.headers.location, url).toString();
        downloadFile(redirectUrl, dest).then(resolve, reject);
        return;
      }
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        file.close();
        fs.unlink(dest, () => {});
        reject(new Error(`Download failed with status ${res.statusCode ?? 'unknown'}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    });
    req.on('error', (err) => {
      file.close();
      fs.unlink(dest, () => {});
      reject(err);
    });
    req.setTimeout(30000, () => {
      file.close();
      fs.unlink(dest, () => {});
      req.destroy();
      reject(new Error('Download timed out'));
    });
  });
}

export function sanitizeFilename(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
}

export interface DownloadPdfResult {
  success: boolean;
  path?: string;
  error?: string;
}

export async function downloadPdfToDir(url: string, filename: string, papersDir: string): Promise<DownloadPdfResult> {
  if (typeof url !== 'string' || typeof filename !== 'string') {
    return { success: false, error: 'Invalid url or filename' };
  }
  if (!url.includes('.pdf')) {
    return { success: false, error: 'URL does not appear to be a PDF' };
  }
  try {
    ensureDir(papersDir);
    const safeName = sanitizeFilename(filename);
    const dest = path.join(papersDir, safeName);
    await downloadFile(url, dest);
    return { success: true, path: dest };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
