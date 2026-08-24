/**
 * CollabService — 协同对话：在 METIS 内嵌入第三方 AI 网页版的独立
 * WebContentsView（豆包 / Kimi / GLM / ChatGPT / Claude / DeepSeek）。
 *
 * 与研究浏览器同构，但使用独立持久分区，AI 站点的登录态与科研浏览器
 * 互不影响。视图由主进程持有，渲染进程只上报宿主区域的 bounds。
 */

import { BrowserWindow, WebContentsView, session, type Session } from 'electron';

export interface CollabBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const COLLAB_PARTITION = 'persist:metis-collab';
const HOME_URL = 'https://www.doubao.com/chat/';

export class CollabService {
  private readonly window: BrowserWindow;
  private view: WebContentsView | null = null;
  private session: Session | null = null;
  private attached = false;
  private bounds: CollabBounds | null = null;
  private currentUrl = '';
  private currentTitle = '';

  constructor(options: { window: BrowserWindow }) {
    this.window = options.window;
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;

    const ses = session.fromPartition(COLLAB_PARTITION);
    this.session = ses;

    const view = new WebContentsView({
      webPreferences: {
        partition: COLLAB_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // No preload: remote AI pages must never gain privileged APIs.
      },
    });
    this.view = view;
    view.setBackgroundColor('#ffffff');
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void this.navigate(url);
      return { action: 'deny' };
    });
    view.webContents.on('did-navigate', (_event, url) => {
      this.currentUrl = url;
    });
    view.webContents.on('did-navigate-in-page', (_event, url) => {
      this.currentUrl = url;
    });
    view.webContents.on('page-title-updated', (_event, title) => {
      this.currentTitle = title;
    });
    view.webContents.on('will-navigate', (event, url) => {
      if (!/^https?:/i.test(url) && url !== 'about:blank') {
        event.preventDefault();
      }
    });
  }

  show(bounds: CollabBounds): void {
    this.attach();
    this.bounds = bounds;
    if (!this.view) return;
    this.view.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) });
    if (!this.window.contentView.children.includes(this.view)) {
      this.window.contentView.addChildView(this.view);
    }
    if (!this.currentUrl) {
      void this.navigate(HOME_URL);
    } else {
      this.view.webContents.focus();
    }
  }

  hide(): void {
    if (this.view && this.window.contentView.children.includes(this.view)) {
      this.window.contentView.removeChildView(this.view);
    }
  }

  setBounds(bounds: CollabBounds): void {
    this.bounds = bounds;
    if (this.view && this.window.contentView.children.includes(this.view)) {
      this.view.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) });
    }
  }

  async navigate(rawUrl: string): Promise<{ ok: boolean; url?: string; error?: string }> {
    this.attach();
    if (!this.view) return { ok: false, error: 'collab_unavailable' };
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { ok: false, error: 'collab_invalid_url' };
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return { ok: false, error: 'collab_invalid_url' };
    }
    try {
      await this.view.webContents.loadURL(url.toString());
      this.currentUrl = url.toString();
      return { ok: true, url: this.currentUrl };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  }

  getState(): { url: string; title: string } {
    return { url: this.currentUrl, title: this.currentTitle };
  }

  destroy(): void {
    this.hide();
    this.view = null;
    this.session = null;
    this.attached = false;
  }
}
