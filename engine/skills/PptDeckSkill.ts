/**
 * Gorden PPT Skill —— METIS Workbench 本体做 PPT 的默认挂载技能。
 *
 * 集成对象：https://github.com/GordenSun/GordenPPTSkill（SKILL.md 协议技能包：
 * 21 套中文 PPT 模板 + python-pptx 换字构建管线，"只替换文字、不破坏排版"）。
 *
 * 集成方式（2026-09-11 刘总要求"作为本体做 PPT 的默认挂载和使用的技能"）：
 * - 模板资产约 100MB 且为第三方设计师非商业授权 → 不进 METIS 仓库分发；
 *   技能首次使用时由 agent 自举获取（git/pip 均在 execute_command 白名单内），
 *   已存在时复用并可用技能自带 apply_update.py 增量更新。
 * - 本模块只提供技能定义（systemPrompt 协议 + 工具白名单）与 PPT 意图判定，
 *   注册进 SkillRegistry 后：对话技能选择器可见、场景工作流可绑定；
 *   用户未显式选技能且消息命中 PPT 意图时，chat 链路自动挂载（默认使用）。
 */

import type { SkillDefinition } from './SkillRegistry.js';

export const GORDEN_PPT_SKILL_ID = 'gorden-ppt-skill';
export const GORDEN_PPT_SKILL_REPO = 'https://github.com/GordenSun/GordenPPTSkill';

/** PPT 意图检测：中文/英文常见表述。命中即视为"做 PPT"需求。 */
export const PPT_INTENT_PATTERN =
  /\bppt\b|\bpptx\b|演示文稿|幻灯片|slides?\b|presentation\b|开题报告|答辩|汇报|路演|keynote/i;

/**
 * 是否应自动挂载 PPT 技能：用户本次请求未显式选择技能，且最后一条用户消息
 * 命中 PPT 意图。用户显式选择了任何技能（含别的技能）时绝不覆盖其选择。
 */
export function shouldAutoMountPptSkill(
  requestedSkillId: string | null | undefined,
  lastUserMessage: string | null | undefined,
): boolean {
  if (requestedSkillId) return false;
  if (!lastUserMessage || !lastUserMessage.trim()) return false;
  return PPT_INTENT_PATTERN.test(lastUserMessage);
}

export interface GordenPptSkillConfig {
  /**
   * 技能工作根目录（主进程传入 DATA_DIR 下的 ppt-skill 目录）：
   * 仓库克隆到 <skillRoot>/gorden-ppt-skill，产物输出到 <skillRoot>/output。
   */
  skillRoot: string;
}

function buildGordenPptSkillPrompt(config: GordenPptSkillConfig): string {
  const repoDirPosix = `${config.skillRoot}/gorden-ppt-skill`;
  const outputDir = `${config.skillRoot}/output`;
  return [
    '你是 METIS 的 PPT 构建执行器，使用 Gorden PPT Skill（gorden-ppt-skill）生成与编辑 PowerPoint。',
    '该技能用 21 套内置中文 PPT 模板（或用户自带的 .pptx 模板）"只替换文字、不破坏原排版/配色/字号"，产出真实 .pptx 文件。',
    '',
    '【第一步：自举（技能目录不存在时）】',
    `技能仓库尚未下载时，先执行：git clone --depth 1 ${GORDEN_PPT_SKILL_REPO} "${repoDirPosix}"`,
    '已存在则进入该目录执行 git pull --ff-only 获取技能更新（技能自带版本增量机制）。',
    '然后确保依赖：python -c "import pptx" 失败时执行 python -m pip install python-pptx。',
    '任一步骤失败（无网络等）：如实告知用户失败原因并停止，不要伪造 PPT 文件。',
    '',
    '【第二步：读技能文档】',
    `${repoDirPosix} 下：SKILL.md（总协议）、templates/INDEX.md（21 套模板清单）、templates/<slug>/intro.md 与 detail.json（每页/slot 详情）、references/pptx-edit-schema.md（edits.json 规范）。用 read_file/execute_command(cat) 读取。`,
    '',
    '【三种模式】',
    'A. 内置模板（默认）：按用户场景从 INDEX.md 选模板；用户未指定且无把握时，给用户 3 个候选（附 preview.png 路径）供选择。',
    'B. 用户自带模板：以用户的 .pptx 为模板，render_slides.py 渲染逐页探查后按 explicit address 写 edits.json；绝不修改用户原文件。',
    'C. 完全原创（用户明确要求时）：简洁版式、单页元素≤4、主色 1 个，python-pptx 直接生成。',
    '',
    '【构建命令】（在技能目录内执行）',
    'python scripts/build_pptx.py templates/<slug>/template.pptx <edits.json> <输出.pptx> --detail templates/<slug>/detail.json',
    `输出统一写到：${outputDir}/<文件名>.pptx（目录不存在先创建），并把完整路径告知用户；提示可在 METIS 成果工作台用"导入 PPTX"把成品收编为项目成果。`,
    '需要逐页预览时：python scripts/render_slides.py <输出.pptx> <渲染目录> --dpi 144（需要 LibreOffice，不可用时如实说明）。',
    '',
    '【edits.json 结构】',
    '{"template_slug":"<slug>","selected_slides":[页码数组],"edits":[{"slide":页码,"slot_id":"槽位id","new_text":"新文字"}]}',
    'slot_id 必须来自该模板 detail.json 的 text_slots；数字/装饰序号（editable:false）默认不动。',
    '',
    '【编辑铁律】',
    '1. 只改文字——形状位置/大小/颜色/字体/字号/行距一律不动。',
    '2. 模板占位文字必须全部替换为真实内容；成品里不得残留示例文本。',
    '3. 严禁用省略号截断凑长度：超长时先精炼重写，其次减要点/换版式，宁可轻微超框也不截断；不要加 --strict。',
    '4. 改目录章节名必须同步分章扉页与面包屑；同级（同 level）文字保持模板原字号一致。',
    '5. 模板封面/目录/结束页角色缺失时按模板能力取舍，不要硬造。',
    '',
    '【许可】该技能与模板为非商业授权（仅供个人学习与研究）；商用需求必须向用户说明此限制。',
  ].join('\n');
}

/** 构造内置 PPT 构建技能定义（main 进程启动时以真实数据目录注册）。 */
export function createGordenPptSkill(config: GordenPptSkillConfig): SkillDefinition {
  return {
    id: GORDEN_PPT_SKILL_ID,
    name: 'PPT 构建引擎（Gorden PPT Skill）',
    description: '用 21 套中文模板或自带模板生成真实 .pptx 文件：只换文字不破坏排版，适合汇报/答辩/提案/课件。',
    category: 'writing',
    systemPrompt: buildGordenPptSkillPrompt(config),
    allowedTools: [
      'execute_command',
      'read_file',
      'write_file',
      'list_directory',
      'create_directory',
    ],
    maxTurns: 24,
    tags: ['ppt', '演示文稿', '模板', '文档生成'],
    version: '1.0.20',
  };
}
