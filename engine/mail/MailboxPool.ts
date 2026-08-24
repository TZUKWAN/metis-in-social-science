/**
 * 注册邮箱池（2026-08-23 刘总需求）：QQ/网易 163 邮箱（IMAP + 授权码）。
 *
 * 用途：自动收取免费模型渠道注册流程中的验证邮件，提取验证链接/验证码。
 * 授权码由调用方经 OS 级 safeStorage 加密持久化；本模块负责连接、读件与
 * 验证内容提取，不负责落盘格式。
 */

export interface MailboxAccount {
  id: string;
  label: string;
  host: string;
  port: number;
  /** 登录名（完整邮箱地址） */
  user: string;
  /** safeStorage 加密后的授权码（本模块不接触明文落盘） */
  encryptedSecret: string;
  createdAt: number;
  lastCheckedAt: number | null;
  lastOkAt: number | null;
}

/** 常见邮箱的 IMAP 预设（刘总确认：仅网易与 QQ）。 */
export const MAILBOX_PRESETS: Record<string, { host: string; port: number; label: string }> = {
  qq: { host: 'imap.qq.com', port: 993, label: 'QQ 邮箱' },
  '163': { host: 'imap.163.com', port: 993, label: '网易 163 邮箱' },
  '126': { host: 'imap.126.com', port: 993, label: '网易 126 邮箱' },
};

export interface RecentMail {
  uid: number;
  from: string;
  subject: string;
  date: number;
  snippet: string;
  links: string[];
  codes: string[];
}

/** 从邮件文本里提取验证链接与验证码。导出仅为测试。 */
export function extractVerification(bodyText: string): { links: string[]; codes: string[] } {
  const links = Array.from(new Set(
    (bodyText.match(/https?:\/\/[^\s"'<>)\]]+/gu) ?? [])
      .map((link) => link.replace(/[.,;!?]+$/u, '')),
  ));
  const codes = new Set<string>();
  // 2026-08-24 实测：米醋API 等站点的验证码是 6 位字母数字混合（如 18958c），
  // 标签码必须接受字母数字，否则永远提取失败。
  const labeled = bodyText.matchAll(/(?:验证码|verification code|code)[^0-9A-Za-z]{0,16}([0-9A-Za-z]{4,8})/giu);
  for (const match of labeled) codes.add(match[1]!);
  if (codes.size === 0) {
    for (const match of bodyText.matchAll(/(?<![0-9A-Za-z])([0-9]{6})(?![0-9A-Za-z])/gu)) codes.add(match[1]!);
  }
  return { links, codes: [...codes] };
}

type ImapFlowConstructor = new (options: Record<string, unknown>) => {
  connect(): Promise<void>;
  logout(): Promise<void>;
  mailboxLock: Promise<unknown> | null;
  messageList(options: { mailbox: string }): AsyncGenerator<{
    uid: number;
    from?: { value?: Array<{ address?: string; name?: string }> };
    subject?: string;
    date?: Date;
  }>;
  download(uid: number, options: { uid: true }): Promise<{ content: { text(): string } } | false>;
  close(): void;
};

/**
 * 连接邮箱并读取最近 limit 封邮件（含验证链接/验证码提取）。
 * imapflow 以运行时依赖注入，保持本模块可单测。
 */
/**
 * 把原始 MIME 源码解码为可提取文本（2026-08-24 米醋实证）。
 * IMAP download() 拿到的是 RFC822 原文：正文可能是 base64 / quoted-printable，
 * 且常为 text/html。本函数：解 multipart 递归 → 按 Content-Transfer-Encoding 解码 →
 * 剥离 HTML 标签，返回纯文本。未识别的结构原样返回（宁滥勿缺，提取器再过滤）。
 */
export function decodeMimeText(raw: string): string {
  const crlfSep = raw.indexOf('\r\n\r\n');
  const lfSep = raw.indexOf('\n\n');
  const sep = crlfSep >= 0 ? '\r\n\r\n' : (lfSep >= 0 ? '\n\n' : null);
  if (sep === null) return stripHtml(raw);
  const headEnd = raw.indexOf(sep);
  const head = raw.slice(0, headEnd);
  const body = raw.slice(headEnd + sep.length);
  const boundaryMatch = /boundary="?([^"\r\n;]+)"?/i.exec(head);
  if (boundaryMatch && /multipart/iu.test(head)) {
    const boundary = boundaryMatch[1]!;
    const parts: string[] = [];
    for (const segment of body.split('--' + boundary)) {
      if (!segment.trim() || segment.trim() === '--') continue;
      const decoded = decodeMimeText(segment);
      if (decoded.trim()) parts.push(decoded);
    }
    return parts.join('\n');
  }
  const cteMatch = /content-transfer-encoding:\s*([^\r\n;]+)/iu.exec(head);
  const cte = cteMatch ? cteMatch[1]!.trim().toLowerCase() : '7bit';
  let text = body;
  if (cte === 'base64') {
    try { text = Buffer.from(body.replace(/\s+/gu, ''), 'base64').toString('utf8'); } catch { text = body; }
  } else if (cte === 'quoted-printable') {
    const cleaned = body.replace(/=\r?\n/gu, '');
    const bytes: number[] = [];
    for (let i = 0; i < cleaned.length; i += 1) {
      if (cleaned[i] === '=' && i + 2 < cleaned.length && /^[0-9A-Fa-f]{2}$/u.test(cleaned.slice(i + 1, i + 3))) {
        bytes.push(parseInt(cleaned.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(cleaned.charCodeAt(i) & 0xff);
      }
    }
    text = Buffer.from(bytes).toString('utf8');
  }
  return stripHtml(text);
}

function stripHtml(text: string): string {
  if (!/<\/?[a-zA-Z][^>]*>/u.test(text)) return text;
  return text
    .replace(/<style[\s\S]*?<\/style>/giu, ' ')
    .replace(/<script[\s\S]*?<\/script>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/[ \t]+/gu, ' ');
}

export async function fetchRecentMails(
  imapFlowCtor: ImapFlowConstructor,
  account: { host: string; port: number; user: string },
  secret: string,
  limit = 10,
): Promise<RecentMail[]> {
  const client = new imapFlowCtor({
    host: account.host,
    port: account.port,
    secure: true,
    auth: { user: account.user, pass: secret },
    logger: false,
    emitLogs: false,
  });
  await client.connect();
  try {
    const locks = client.messageList({ mailbox: 'INBOX' });
    const collected: RecentMail[] = [];
    for await (const message of locks) {
      if (collected.length >= limit) break;
      const downloaded = await client.download(message.uid, { uid: true });
      const bodyText = downloaded && downloaded.content ? downloaded.content.text() : '';
      const verification = extractVerification(bodyText);
      collected.push({
        uid: message.uid,
        from: message.from?.value?.[0]?.address ?? '',
        subject: message.subject ?? '',
        date: message.date ? message.date.getTime() : 0,
        snippet: bodyText.replace(/\s+/gu, ' ').slice(0, 200),
        links: verification.links.slice(0, 6),
        codes: verification.codes.slice(0, 4),
      });
    }
    return collected;
  } finally {
    try { client.close(); } catch { /* best effort */ }
  }
}
