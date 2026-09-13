#!/usr/bin/env node
/**
 * T00.04 — extreme UI stress fixture seeder.
 *
 * Seeds a COPY of the real METIS userData clone (never the live profile) with
 * layout-stress data: 20 projects, 50 sessions on the first project, 1000
 * messages with long CJK/markdown/table/code/LaTeX bodies, 30 papers and 20
 * notes with extreme-length titles/tags.
 *
 * Usage: node scripts/seed-ui-stress-fixture.mjs --db=<metis.db path>
 * Requires the Node ABI build of better-sqlite3 (npm rebuild better-sqlite3).
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { PersistenceStore } = await import(pathToFileURL(path.join(root, 'dist-electron/engine/persistence/PersistenceStore.js')).href);
const { ResearchRepository } = await import(pathToFileURL(path.join(root, 'dist-electron/engine/persistence/ResearchRepository.js')).href);

const arg = process.argv.find((a) => a.startsWith('--db='));
if (!arg) { console.error('usage: --db=<metis.db>'); process.exit(2); }
const dbPath = path.resolve(arg.split('=').slice(1).join('='));

const longCjk = (n, seed) => Array.from({ length: n }, (_, i) => '劳「动」过程与算法治理研究'[(i + seed) % 12]).join('');
const markdownBody = (i) => [
  `## 压力测试段落 ${i} ${longCjk(30, i)}`,
  '',
  '| 指标 | 数值 | 说明 |',
  '|---|---|---|',
  '|BLEU|' + (i % 100) + '.25|长表格单元“' + longCjk(20, i) + '”|',
  '|样本量|12,8' + (i % 10) + '|混合 mixed EN/中文 排版|',
  '',
  '```python',
  'def stress_' + i + '(x):',
  '    return [x ** 2 for x in range(10)]  # 代码块宽度压力测试 "quotes"',
  '```',
  '',
  '公式：$\\int_0^1 x^2\\,dx = \\frac{1}{3}$，行内 $E=mc^2$。',
  '',
  longCjk(400, i),
].join('\n');

const store = new PersistenceStore(dbPath);
const repo = new ResearchRepository(store.raw);
const now = Date.now();

// ── 20 projects (two with 100-char titles) ─────────────────────────
const makeProject = (id, title) => ({
  id, title, originalIntent: '', researchQuestion: '', lifecycle: 'active',
  methodology: '', discipline: '', metadata: {}, createdAt: now, updatedAt: now,
  archivedAt: null, version: 1, source: 'user', deletedAt: null,
});
for (let p = 1; p <= 20; p += 1) {
  const id = `stress-proj-${String(p).padStart(2, '0')}`;
  const title = p <= 2 ? `压力测试项目${p}·${longCjk(46, p)}` : `压力测试项目 ${p}`;
  repo.createProject(makeProject(id, title));
}

// ── 50 sessions on project 01, 20 messages each (=1000) ────────────
const roles = ['user', 'assistant'];
for (let s = 1; s <= 50; s += 1) {
  const sid = `stress-sess-${String(s).padStart(2, '0')}`;
  const title = s === 1 ? `超长会话标题·${longCjk(55, s)}` : `压力会话 ${s}`;
  store.createSession(sid, { topic: title }, 'stress-proj-01');
  for (let m = 0; m < 20; m += 1) {
    const role = roles[m % 2];
    const content = m % 5 === 0 ? markdownBody(m) : `${role === 'user' ? '提问：' : '回答：'}${longCjk(120 + m, s * m + 1)}`;
    store.appendMessage(sid, role, content);
  }
}

// ── 30 papers with long titles / many tags ─────────────────────────
for (let p = 1; p <= 30; p += 1) {
  store.savePaper({
    id: `stress-paper-${String(p).padStart(2, '0')}`,
    title: p <= 2 ? `超长论文题名：平台劳动、算法管理与劳动过程控制的理论重构${longCjk(20, p)}` : `压力测试论文 ${p}`,
    authors: ['张三', '李四', 'Smith, J.'],
    year: 2020 + (p % 6),
    venue: 'Journal of Stress Testing',
    abstract: longCjk(200, p),
    tags: ['平台劳动', '算法治理', '定性研究', 'stress'],
    notes: '', readStatus: 'unread', rating: p % 6, addedAt: now + p,
  });
}

// ── 20 notes with long markdown ────────────────────────────────────
for (let n = 1; n <= 20; n += 1) {
  store.saveNote({
    id: `stress-note-${String(n).padStart(2, '0')}`,
    title: n === 1 ? `超长笔记标题·${longCjk(50, n)}` : `压力笔记 ${n}`,
    content: markdownBody(n),
    tags: ['压力', 'markdown'],
    linkedPaperIds: [], linkedNoteIds: [], starred: n % 4 === 0,
    updatedAt: now + n, scope: 'research', projectId: 'stress-proj-01',
  });
}

const counts = {
  projects: store.raw.prepare("select count(*) c from projects where id like 'stress-%'").get().c,
  sessions: store.raw.prepare("select count(*) c from sessions where id like 'stress-%'").get().c,
  messages: store.raw.prepare("select count(*) c from messages where session_id like 'stress-%'").get().c,
  papers: store.raw.prepare("select count(*) c from papers where id like 'stress-%'").get().c,
  notes: store.raw.prepare("select count(*) c from notes where id like 'stress-%'").get().c,
};
store.close();
console.log('STRESS SEEDED', JSON.stringify(counts));
