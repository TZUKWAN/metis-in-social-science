/**
 * Capability 源注册表与展开导入器(2026-09-05 刘总要求,任务7 7B/十四节)。
 *
 * 10 个 GitHub 预置来源注册在案;导入器把每个来源**逐内部 Skill 展开**为
 * CapabilityManifest 条目(保留 sourceRepo/originalPath/version/license/digest/
 * tags),license 不允许/来源不明/内容不兼容时如实标注,不为数量强行复制。
 * 展开是纯函数(fetcher 由调用方注入:GitHub API/本地克隆/预包数据均可)。
 */

export interface CapabilitySourceSpec {
  id: string;
  repo: string;
  name: string;
  /** 逐内部 Skill 展开(仓库含多个独立 SKILL.md)或单条导入。 */
  expansion: 'per_skill' | 'single';
  domains: string[];
  researchStages: string[];
  /** license 待核验标记:导入器会如实写入 manifest,不假装已确认。 */
  licenseStatus: 'verified' | 'unverified';
  notes?: string;
}

export const CAPABILITY_SOURCES: readonly CapabilitySourceSpec[] = [
  { id: 'auto-empirical-research', repo: 'brycewang-stanford/Auto-Empirical-Research-Skills', name: 'Auto Empirical Research Skills', expansion: 'per_skill', domains: ['实证研究', '计算社会科学'], researchStages: ['analysis', 'writing'], licenseStatus: 'unverified' },
  { id: 'research-writing-skill', repo: 'Norman-bury/research-writing-skill', name: 'Research Writing Skill', expansion: 'single', domains: ['学术写作'], researchStages: ['writing'], licenseStatus: 'unverified' },
  { id: 'academicforge', repo: 'HughYau/AcademicForge', name: 'AcademicForge', expansion: 'per_skill', domains: ['学术写作', '研究方法'], researchStages: ['writing', 'review'], licenseStatus: 'unverified' },
  { id: 'paper-search-mcp', repo: 'openags/paper-search-mcp', name: 'Paper Search MCP', expansion: 'single', domains: ['文献检索'], researchStages: ['literature'], licenseStatus: 'unverified', notes: 'MCP 形态(外部 Tool Provider)' },
  { id: 'academic-humanizer', repo: 'AIScientists-Dev/academic-humanizer', name: 'Academic Humanizer', expansion: 'single', domains: ['学术表达'], researchStages: ['writing'], licenseStatus: 'unverified' },
  { id: 'cnki-skills', repo: 'cookjohn/cnki-skills', name: 'CNKI Skills', expansion: 'per_skill', domains: ['中文文献'], researchStages: ['literature'], licenseStatus: 'unverified', notes: '仅收编合法工作流;违反站点条款的自动化能力不导入' },
  { id: 'humanities-thesis-skill', repo: 'ganzhi-black/humanities-thesis-skill', name: 'Humanities Thesis Skill', expansion: 'single', domains: ['人文', '学位论文'], researchStages: ['writing'], licenseStatus: 'unverified' },
  { id: 'research-plugins', repo: 'wentorai/research-plugins', name: 'Research Plugins', expansion: 'per_skill', domains: ['研究方法'], researchStages: ['analysis', 'writing'], licenseStatus: 'unverified' },
  { id: 'social-science-paper-writing', repo: 'fakerqwq/social-science-paper-writing-skill', name: 'Social Science Paper Writing', expansion: 'single', domains: ['社会科学写作'], researchStages: ['writing'], licenseStatus: 'unverified' },
  { id: 'ai-research-skills', repo: 'WenyuChiou/ai-research-skills', name: 'AI Research Skills', expansion: 'per_skill', domains: ['研究方法', 'AI辅助'], researchStages: ['analysis'], licenseStatus: 'unverified' },
];

export interface ExpandedCapabilityManifest {
  id: string;
  kind: 'skill' | 'mcp';
  name: string;
  description: string;
  sourceRepo: string;
  sourceId: string;
  originalPath: string;
  version: string;
  license: string | null;
  licenseStatus: 'verified' | 'unverified';
  domains: string[];
  researchStages: string[];
  tags: string[];
  contentDigest: string;
  /** 导入判定:included=false 时如实记录排除原因,不为数量强行复制。 */
  included: boolean;
  exclusionReason?: string;
  systemPrompt: string;
}

function extractFrontmatterField(frontmatter: string, field: string): string | null {
  const match = new RegExp(`^${field}:\\s*(.+)$`, 'mu').exec(frontmatter);
  return match ? match[1]!.trim().slice(0, 300) : null;
}

/** 简单确定性 digest(导入排序/冻结用;安全审计另有正式摘要工具)。 */
export function contentDigest(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0') + (text.length.toString(16));
}

export interface RepoSkillFile {
  path: string;
  content: string;
}

/**
 * 逐 Skill 展开:扫描一个来源仓库的全部 SKILL.md 文件,产出 CapabilityManifest
 * 候选条目。name 为空/正文过短(<80 字符,无实质内容)/含明显不兼容标记时
 * excluded=true 并如实写明原因。
 */
export function expandSourceSkills(source: CapabilitySourceSpec, files: RepoSkillFile[]): ExpandedCapabilityManifest[] {
  const manifests: ExpandedCapabilityManifest[] = [];
  for (const file of files) {
    const lower = file.path.toLowerCase();
    if (!lower.endsWith('skill.md')) continue;
    const frontmatterMatch = /^---\n([\s\S]*?)\n---/.exec(file.content);
    const frontmatter = frontmatterMatch?.[1] ?? '';
    const name = extractFrontmatterField(frontmatter, 'name')
      ?? /^#\s+(.+)$/mu.exec(file.content)?.[1]?.trim()
      ?? file.path.split('/').slice(-2, -1)[0]
      ?? source.id;
    const description = extractFrontmatterField(frontmatter, 'description')
      ?? file.content.split('\n').find((line) => line.trim().length > 30 && !line.startsWith('#'))?.trim().slice(0, 300)
      ?? '';
    const license = extractFrontmatterField(frontmatter, 'license');
    const bodyStart = frontmatterMatch ? file.content.indexOf('---', 4) + 3 : 0;
    const body = file.content.slice(bodyStart).trim();
    if (body.length < 80) {
      manifests.push({
        id: `${source.id}:${file.path}`,
        kind: 'skill', name, description, sourceRepo: source.repo, sourceId: source.id,
        originalPath: file.path, version: '1', license, licenseStatus: source.licenseStatus,
        domains: source.domains, researchStages: source.researchStages,
        tags: [...source.domains, ...source.researchStages], contentDigest: contentDigest(file.content),
        included: false, exclusionReason: 'SKILL.md 无实质内容(正文不足 80 字符)', systemPrompt: '',
      });
      continue;
    }
    manifests.push({
      id: `${source.id}:${file.path}`,
      kind: 'skill', name, description, sourceRepo: source.repo, sourceId: source.id,
      originalPath: file.path, version: '1',
      license: license ?? source.licenseStatus === 'verified' ? license : (license ?? 'UNVERIFIED'),
      licenseStatus: source.licenseStatus,
      domains: source.domains, researchStages: source.researchStages,
      tags: [...source.domains, ...source.researchStages], contentDigest: contentDigest(file.content),
      included: true, systemPrompt: file.content.trim(),
    });
  }
  return manifests;
}
