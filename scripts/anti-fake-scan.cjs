// Anti-fake-implementation scan (METIS-1009) — run with: node scripts/anti-fake-scan.cjs
const fs = require('fs');
const path = require('path');

const MARKERS = ['TODO', 'FIXME', 'mock', 'stub', 'placeholder', 'demo', 'fake', 'hardcoded', 'not implemented', '未实现', '占位'];

function walk(d, out = []) {
  let entries;
  try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'dist', 'dist-electron', '.git', 'coverage'].includes(e.name)) continue;
      walk(p, out);
    } else if (/\.[tj]sx?$/.test(e.name) && !/\.test\.[tj]sx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const roots = ['engine', 'src', 'electron'];
const files = roots.flatMap((r) => walk(r)).map((p) => ({ path: p, content: fs.readFileSync(p, 'utf8') }));

const findings = [];
for (const f of files) {
  const ls = f.content.split('\n');
  for (let i = 0; i < ls.length; i++) {
    const lo = ls[i].toLowerCase();
    for (const m of MARKERS) {
      if (lo.includes(m.toLowerCase())) {
        findings.push({ file: f.path, line: i + 1, marker: m, snippet: ls[i].trim().slice(0, 100) });
        break;
      }
    }
  }
}

console.log('生产代码 fake marker 发现数:', findings.length);
const byFile = {};
for (const f of findings) byFile[f.file] = (byFile[f.file] || 0) + 1;
console.log('\n按文件分布 (top 15):');
for (const [k, v] of Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log('  ' + v + 'x  ' + k);
}
console.log('\n--- 样例（前 15 条，供人工判断）---');
findings.slice(0, 15).forEach((f) => console.log(`${f.file}:${f.line} [${f.marker}] ${f.snippet}`));
