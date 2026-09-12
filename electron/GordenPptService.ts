/**
 * GordenPptService —— METIS Office PPT 的 Gorden 模板生成服务。
 *
 * 把 GordenPPTSkill（21 套中文模板 + python-pptx 换字构建管线）挂接进
 * METIS Office 的 PPT：Ribbon「设计 → Gorden 模板库」选模板、填要点，
 * 本服务执行技能的 build_pptx.py 产出 .pptx，再经 OutcomePptxService
 * 转成 METIS PPT Grid 文档直接载入 Office 画布（用户保存即成成果版本）。
 *
 * 技能包（约 100MB，第三方非商业模板）不随应用分发：ensureSkillPackage
 * 在首次使用时 git clone 到数据目录，已存在则复用（可用 git pull 更新）。
 * python / git 不可用时如实报错，绝不伪造产物。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OutcomePptxService } from './OutcomePptxService.js';

export const GORDEN_PPT_SKILL_REPO = 'https://github.com/GordenSun/GordenPPTSkill';

export interface GordenPptTemplateSummary {
  slug: string;
  name: string;
  slideCount: number;
  /** 模板可用的页面角色摘要（cover/agenda/content/...），供 UI 展示。 */
  roles: string[];
  previewPath: string | null;
}

export interface GordenPptEdit {
  slide: number;
  slot_id: string;
  new_text: string;
}

export interface GordenPptBuildResult {
  ok: boolean;
  code?: string;
  message: string;
  fileName?: string;
  /** 转换后的 METIS PPT Grid 文档（OutcomePptDocument['version']['content'] 形状）。 */
  document?: unknown;
  warnings?: string[];
  /** build_pptx.py 的出框/容量提示（非阻断），供 UI 展示。 */
  buildLog?: string;
}

function execFile(command: string, args: string[], options: { cwd: string; timeout: number }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), options.timeout);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export interface GordenPptBrief {
  slug: string;
  /** 演示文稿标题（填封面/各页标题位）。 */
  title: string;
  /** 要点列表（循环填充正文/正文位；不足时轮替复用，不伪造新事实）。 */
  points: string[];
  /** 最多取前 N 个有可编辑文本的页面。 */
  maxSlides?: number;
}

interface DetailSlot { slot_id: string; editable?: boolean }
interface DetailPage { slide_number?: number; text_slots?: DetailSlot[] }
interface GordenSkillDetail { name?: string; slide_count?: number; pages?: DetailPage[] }

/**
 * 把"标题 + 要点"组装成 edits：可编辑 slot 全部填充（无模板占位残留），
 * 数字/序号类装饰位（editable:false）保持不动——对应 SKILL.md 编辑铁律。
 * 纯函数，单测覆盖。
 */
export function composeEditsFromBrief(
  detail: GordenSkillDetail,
  title: string,
  points: string[],
  maxSlides = 3,
): { selectedSlides: number[]; edits: GordenPptEdit[] } {
  const cleanTitle = title.trim();
  const cleanPoints = points.map((point) => point.trim()).filter(Boolean);
  const selectedSlides: number[] = [];
  const edits: GordenPptEdit[] = [];
  let pointIndex = 0;
  const nextPoint = (): string => {
    if (cleanPoints.length === 0) return cleanTitle;
    const value = cleanPoints[pointIndex % cleanPoints.length]!;
    pointIndex += 1;
    return value;
  };
  for (const page of detail.pages ?? []) {
    if (selectedSlides.length >= maxSlides) break;
    const slide = page.slide_number;
    if (typeof slide !== 'number' || slide <= 0) continue;
    const slots = page.text_slots ?? [];
    if (slots.length === 0) continue;
    selectedSlides.push(slide);
    const firstPoint = cleanPoints[selectedSlides.length - 1] ?? cleanPoints[0] ?? cleanTitle;
    for (const slot of slots) {
      if (slot.editable === false) continue;
      const id = slot.slot_id;
      let text: string;
      if (/_en$/iu.test(id)) text = cleanTitle;
      else if (/title/iu.test(id)) text = selectedSlides.length === 1 ? cleanTitle : firstPoint;
      else if (/_cn$/iu.test(id)) text = firstPoint;
      else text = nextPoint();
      edits.push({ slide, slot_id: id, new_text: text });
    }
  }
  return { selectedSlides, edits };
}

export class GordenPptService {
  constructor(private readonly skillRoot: string) {}

  get skillDir(): string {
    return path.join(this.skillRoot, 'gorden-ppt-skill');
  }

  get templatesDir(): string {
    return path.join(this.skillDir, 'templates');
  }

  /** 技能包就位（缺失时 git clone --depth 1 自举）。python-pptx 依赖由构建时报错引导。 */
  async ensureSkillPackage(): Promise<{ ok: boolean; cloned: boolean; message: string }> {
    if (existsSync(path.join(this.skillDir, 'SKILL.md'))) {
      return { ok: true, cloned: false, message: '技能包已就绪。' };
    }
    await fs.mkdir(this.skillRoot, { recursive: true });
    const clone = await execFile('git', ['clone', '--depth', '1', GORDEN_PPT_SKILL_REPO, this.skillDir], {
      cwd: this.skillRoot, timeout: 600_000,
    });
    if (!(existsSync(path.join(this.skillDir, 'SKILL.md')))) {
      return {
        ok: false, cloned: false,
        message: `技能包下载失败（git clone 未完成）：${(clone.stderr || clone.stdout || '未知原因').slice(-300)}`,
      };
    }
    return { ok: true, cloned: true, message: '技能包已下载完成。' };
  }

  /** 枚举模板清单（读每个模板的 detail.json 元数据，不加载模板正文）。 */
  async listTemplates(): Promise<GordenPptTemplateSummary[]> {
    if (!existsSync(this.templatesDir)) return [];
    const summaries: GordenPptTemplateSummary[] = [];
    for (const entry of (await fs.readdir(this.templatesDir, { withFileTypes: true })).filter((e) => e.isDirectory())) {
      const detailPath = path.join(this.templatesDir, entry.name, 'detail.json');
      if (!existsSync(detailPath)) continue;
      try {
        const detail = JSON.parse(await fs.readFile(detailPath, 'utf-8')) as {
          name?: string; slide_count?: number; pages?: Array<{ role?: string }>;
        };
        const roles = [...new Set((detail.pages ?? []).map((page) => page.role).filter((role): role is string => Boolean(role)))];
        summaries.push({
          slug: entry.name,
          name: detail.name ?? entry.name,
          slideCount: detail.slide_count ?? detail.pages?.length ?? 0,
          roles,
          previewPath: existsSync(path.join(this.templatesDir, entry.name, 'preview.png'))
            ? path.join(this.templatesDir, entry.name, 'preview.png')
            : null,
        });
      } catch {
        // 单个 detail.json 损坏只跳过该模板，不破坏整个清单。
      }
    }
    return summaries.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  /** 读一个模板的 detail.json（给 buildFromBrief 组装 edits 用）。 */
  async readDetail(slug: string): Promise<GordenSkillDetail | null> {
    if (!/^[\w-]+$/u.test(slug)) return null;
    const detailPath = path.join(this.templatesDir, slug, 'detail.json');
    if (!existsSync(detailPath)) return null;
    try {
      return JSON.parse(await fs.readFile(detailPath, 'utf-8')) as GordenSkillDetail;
    } catch {
      return null;
    }
  }

  /** Office 入口：模板 + 标题 + 要点 → 组装 edits → 构建 → Grid 文档。 */
  async buildFromBrief(brief: GordenPptBrief): Promise<GordenPptBuildResult & { selectedSlides?: number[]; edits?: GordenPptEdit[] }> {
    const detail = await this.readDetail(brief.slug);
    if (!detail) return { ok: false, code: 'template_not_found', message: `模板 ${brief.slug} 不存在或已损坏。` };
    const { selectedSlides, edits } = composeEditsFromBrief(detail, brief.title, brief.points, brief.maxSlides ?? 3);
    if (selectedSlides.length === 0) return { ok: false, code: 'template_not_usable', message: '该模板没有可编辑的文本位。' };
    const built = await this.buildDeck({ slug: brief.slug, selectedSlides, edits, outName: brief.title });
    return { ...built, selectedSlides, edits };
  }

  /**
   * 执行技能构建并把产物转成 METIS PPT Grid 文档。
   * edits 为空时直接产出模板原样选页（用于先要一个"模板底稿"再在 Office 里改）。
   */
  async buildDeck(input: { slug: string; selectedSlides: number[]; edits: GordenPptEdit[]; outName?: string }): Promise<GordenPptBuildResult> {
    const slug = String(input.slug || '');
    if (!/^[\w-]+$/u.test(slug)) return { ok: false, code: 'invalid_slug', message: '模板标识不合法。' };
    const templateDir = path.join(this.templatesDir, slug);
    if (!existsSync(path.join(templateDir, 'template.pptx'))) {
      return { ok: false, code: 'template_not_found', message: `模板 ${slug} 不存在；请先初始化技能包或换一个模板。` };
    }
    const workDir = await fs.mkdtemp(path.join(this.skillRoot, 'build-'));
    try {
      const safeName = (input.outName ?? slug).replace(/[\\/:*?"<>|]+/gu, '-').slice(0, 100) || slug;
      const editsPath = path.join(workDir, 'edits.json');
      const outPath = path.join(workDir, 'deck.pptx');
      await fs.writeFile(editsPath, JSON.stringify({
        template_slug: slug,
        selected_slides: input.selectedSlides,
        edits: input.edits,
      }, null, 1), 'utf-8');
      const build = await execFile('python', [
        'scripts/build_pptx.py',
        path.join(this.skillDir, 'templates', slug, 'template.pptx'), editsPath, outPath,
        '--detail', path.join(this.skillDir, 'templates', slug, 'detail.json'),
      ], { cwd: this.skillDir, timeout: 300_000 });
      if (!existsSync(outPath)) {
        return {
          ok: false, code: 'build_failed',
          message: `构建没有产出文件：${(build.stderr || build.stdout || 'python 未安装或 python-pptx 缺失（pip install python-pptx）').slice(-400)}`,
          buildLog: (build.stdout + build.stderr).slice(-800),
        };
      }
      const bytes = await fs.readFile(outPath);
      const imported = await new OutcomePptxService().importBufferV2(bytes);
      return {
        ok: true,
        message: '构建完成，已转换为 METIS PPT 文档。',
        fileName: `${safeName}.pptx`,
        document: imported.document,
        warnings: imported.warnings.map((warning) => typeof warning === 'string' ? warning : warning.message),
        buildLog: (build.stdout + build.stderr).slice(-800),
      };
    } catch (error) {
      return { ok: false, code: 'build_error', message: `构建执行失败：${error instanceof Error ? error.message : String(error)}` };
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }
}
