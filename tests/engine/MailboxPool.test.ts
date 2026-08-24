/**
 * MailboxPool 解码与验证码提取测试（2026-08-24 米醋API 实证样本）。
 * 实证事实：
 *  1. IMAP download 返回原始 MIME；验证邮件是 base64 编码的 text/html；
 *  2. 验证码可以是 6 位字母数字混合（米醋实测 18958c）；
 *  3. QQ 会把中转站验证邮件判进 Junk（文件夹遍历在 FreeModelService 侧）。
 */
import { describe, it, expect } from 'vitest';
import { decodeMimeText, extractVerification } from '../../engine/mail/MailboxPool.js';

// 米醋API 真实验证邮件正文（base64 原样样本，内容：您好，你正在进行米醋API 邮箱验证。您的验证码为: 18958c …）
const MICU_BODY_B64 =
  'PHA+5oKo5aW977yM5L2g5q2j5Zyo6L+b6KGM57Gz6YaLQVBJIOmCrueusemqjOivgeOAgjwvcD48cD7mgqjnmoTpqozor4HnoIHkuLo6IDxzdHJvbmc+MTg5NThjPC9zdHJvbmc+PC9wPjxwPumqjOivgeeggSAxMCDliIbpkp/lhoXmnInmlYjvvIzlpoLmnpzkuI3mmK/mnKzkurrmk43kvZzvvIzor7flv73nlaXjgII8L3A+';
const MICU_RAW = [
  'From: noreply@mail.micuapi.ai',
  'Subject: =?UTF-8?b?57Gz6YaLQVBJIOmCrueusemqjOivgemCruS7tg==?=',
  'Content-Type: text/html; charset=UTF-8',
  'Content-Transfer-Encoding: base64',
  '',
  MICU_BODY_B64,
].join('\r\n');

describe('decodeMimeText', () => {
  it('decodes base64 html bodies to plain text (米醋实证)', () => {
    const text = decodeMimeText(MICU_RAW);
    expect(text).toContain('米醋');
    expect(text).toContain('18958c');
    expect(text).not.toContain('<strong>');
    expect(text).not.toContain('PHA+');
  });
  it('handles quoted-printable utf-8', () => {
    const raw = 'Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n=E6=82=A8=E7=9A=84=E9=AA=8C=E8=AF=81=E7=A0=81=E4=B8=BA: 123456';
    const text = decodeMimeText(raw);
    expect(text).toContain('123456');
  });
  it('recurses multipart/alternative', () => {
    const raw = [
      'Content-Type: multipart/alternative; boundary="abc123"',
      '',
      '--abc123',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('plain part code 777777', 'utf8').toString('base64'),
      '--abc123',
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('<p>html part <b>888888</b></p>', 'utf8').toString('base64'),
      '--abc123--',
    ].join('\r\n');
    const text = decodeMimeText(raw);
    expect(text).toContain('777777');
    expect(text).toContain('888888');
  });
  it('returns plain text untouched when no MIME headers', () => {
    expect(decodeMimeText('your code is 424242')).toContain('424242');
  });
});

describe('extractVerification alphanumeric codes', () => {
  it('extracts 6-char alphanumeric labeled codes (米醋 18958c)', () => {
    const text = decodeMimeText(MICU_RAW);
    const { codes } = extractVerification(text);
    expect(codes).toContain('18958c');
  });
  it('still extracts pure-digit codes', () => {
    const { codes } = extractVerification('您的验证码为: 246810，5 分钟内有效');
    expect(codes).toContain('246810');
  });
  it('falls back to six-digit scan when unlabeled', () => {
    const { codes } = extractVerification('hello 135790 world');
    expect(codes).toContain('135790');
  });
  it('does not extract long words as codes', () => {
    const { codes } = extractVerification('verification completed successfully');
    expect(codes).toEqual([]);
  });
});
