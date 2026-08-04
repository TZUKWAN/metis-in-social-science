/**
 * OfficeFormatToolbar — Word/PPT formatting controls that map directly to
 * officecli properties. The user selects a paragraph/run path (or just picks
 * the last paragraph for quick formatting) and clicks a button; the toolbar
 * calls officeCliSet and the parent refreshes the preview.
 */

import { useTranslation } from '../i18n';

interface OfficeFormatToolbarProps {
  disabled: boolean;
  onSetProps: (props: Record<string, string>) => Promise<void>;
}

const HEADING_STYLES = [
  { value: '', label: '正文' },
  { value: 'Heading1', label: '一级标题' },
  { value: 'Heading2', label: '二级标题' },
  { value: 'Heading3', label: '三级标题' },
];

const FONT_SIZES = ['9', '10', '11', '12', '14', '16', '18', '20', '24', '28', '32'];

const ALIGNMENTS: Array<{ value: string; icon: string; title: string }> = [
  { value: 'left', icon: '⬅', title: '左对齐' },
  { value: 'center', icon: '↔', title: '居中' },
  { value: 'right', icon: '➡', title: '右对齐' },
  { value: 'justify', icon: '☰', title: '两端对齐' },
  { value: 'distribute', icon: '⋮⋮⋮', title: '分散对齐' },
];

const LINE_SPACINGS = ['1.0', '1.15', '1.5', '2.0'];

const CN_FONTS = ['宋体', '黑体', '微软雅黑', '楷体', '仿宋', '等线'];
const EN_FONTS = ['Times New Roman', 'Arial', 'Calibri', 'Cambria', 'Georgia'];

const TEXT_COLORS = [
  { value: '000000', label: '黑' },
  { value: 'FF0000', label: '红' },
  { value: '0000FF', label: '蓝' },
  { value: '008000', label: '绿' },
  { value: 'FFA500', label: '橙' },
  { value: '800080', label: '紫' },
  { value: '808080', label: '灰' },
];

const toolbarBtn: React.CSSProperties = {
  padding: '3px 8px',
  fontSize: 12,
  minWidth: 28,
  cursor: 'pointer',
  border: '1px solid var(--border)',
  borderRadius: 3,
  background: 'var(--bg-card)',
  color: 'var(--text-primary)',
};

const toolbarSelect: React.CSSProperties = {
  padding: '2px 4px',
  fontSize: 12,
  border: '1px solid var(--border)',
  borderRadius: 3,
  background: 'var(--bg-card)',
  color: 'var(--text-primary)',
};

export default function OfficeFormatToolbar({ disabled, onSetProps }: OfficeFormatToolbarProps) {
  const { t } = useTranslation();

  const handle = (props: Record<string, string>) => {
    if (!disabled) void onSetProps(props);
  };

  return (
    <div className="office-format-toolbar" data-testid="office-format-toolbar" style={{
      display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center',
      padding: '6px 8px', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)',
    }}>
      {/* Heading level */}
      <select
        style={toolbarSelect}
        disabled={disabled}
        title={t('office.addHeading')}
        onChange={(e) => {
          const style = e.target.value;
          handle(style ? { style } : { style: 'Normal' });
          e.target.value = '';
        }}
        defaultValue=""
      >
        <option value="" disabled>标题▼</option>
        {HEADING_STYLES.map((h) => <option key={h.value || 'normal'} value={h.value}>{h.label}</option>)}
      </select>

      {/* Chinese font */}
      <select
        style={toolbarSelect}
        disabled={disabled}
        title="中文字体"
        onChange={(e) => { handle({ 'font.ea': e.target.value }); e.target.value = ''; }}
        defaultValue=""
      >
        <option value="" disabled>中文字体▼</option>
        {CN_FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
      </select>

      {/* Latin font */}
      <select
        style={toolbarSelect}
        disabled={disabled}
        title="英文字体"
        onChange={(e) => { handle({ 'font.latin': e.target.value }); e.target.value = ''; }}
        defaultValue=""
      >
        <option value="" disabled>英文字体▼</option>
        {EN_FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
      </select>

      {/* Font size */}
      <select
        style={toolbarSelect}
        disabled={disabled}
        title="字号"
        onChange={(e) => { handle({ size: e.target.value }); e.target.value = ''; }}
        defaultValue=""
      >
        <option value="" disabled>字号▼</option>
        {FONT_SIZES.map((s) => <option key={s} value={s}>{s}pt</option>)}
      </select>

      <span style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 2px' }} />

      {/* Bold / Italic / Underline / Strikethrough */}
      <button type="button" style={{ ...toolbarBtn, fontWeight: 700 }} disabled={disabled} onClick={() => handle({ bold: 'true' })} title="加粗">B</button>
      <button type="button" style={{ ...toolbarBtn, fontStyle: 'italic' }} disabled={disabled} onClick={() => handle({ italic: 'true' })} title="斜体">I</button>
      <button type="button" style={{ ...toolbarBtn, textDecoration: 'underline' }} disabled={disabled} onClick={() => handle({ underline: 'single' })} title="下划线">U</button>
      <button type="button" style={{ ...toolbarBtn, textDecoration: 'line-through' }} disabled={disabled} onClick={() => handle({ strike: 'true' })} title="删除线">S</button>

      <span style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 2px' }} />

      {/* Alignment */}
      {ALIGNMENTS.map((a) => (
        <button key={a.value} type="button" style={toolbarBtn} disabled={disabled} onClick={() => handle({ align: a.value })} title={a.title}>{a.icon}</button>
      ))}

      <span style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 2px' }} />

      {/* Line spacing */}
      <select
        style={toolbarSelect}
        disabled={disabled}
        title="行距"
        onChange={(e) => { handle({ lineSpacing: e.target.value, lineRule: 'auto' }); e.target.value = ''; }}
        defaultValue=""
      >
        <option value="" disabled>行距▼</option>
        {LINE_SPACINGS.map((s) => <option key={s} value={s}>{s}x</option>)}
      </select>

      {/* First line indent */}
      <button type="button" style={toolbarBtn} disabled={disabled} onClick={() => handle({ firstLineIndent: '2cm' })} title="首行缩进2字符">≡</button>

      <span style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 2px' }} />

      {/* Text color */}
      <select
        style={toolbarSelect}
        disabled={disabled}
        title="字体颜色"
        onChange={(e) => { handle({ color: e.target.value }); e.target.value = ''; }}
        defaultValue=""
      >
        <option value="" disabled>颜色▼</option>
        {TEXT_COLORS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
      </select>

      {/* List styles */}
      <button type="button" style={toolbarBtn} disabled={disabled} onClick={() => handle({ listStyle: 'bullet' })} title="项目符号">•</button>
      <button type="button" style={toolbarBtn} disabled={disabled} onClick={() => handle({ listStyle: 'ordered' })} title="编号列表">1.</button>
    </div>
  );
}
