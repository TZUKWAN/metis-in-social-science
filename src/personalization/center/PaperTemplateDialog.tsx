import { Upload, X } from 'lucide-react';

/**
 * 模板识别弹窗（论文结构）：粘贴模板 → AI 解析为逐节写作指引 → 用户修改后保存。
 * 状态与解析/导入/保存编排保留在 PersonalizationCenter，这里只承载弹窗界面。
 */
export function PaperTemplateDialog({
  zh,
  text,
  busy,
  status,
  name,
  sections,
  onTextChange,
  onNameChange,
  onUpdateSection,
  onRemoveSection,
  onClose,
  onParse,
  onImportFile,
  onSave,
}: {
  zh: boolean;
  text: string;
  busy: boolean;
  status: string;
  name: string;
  sections: Array<{ title: string; instruction: string }>;
  onTextChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onUpdateSection: (index: number, field: 'title' | 'instruction', value: string) => void;
  onRemoveSection: (index: number) => void;
  onClose: () => void;
  onParse: () => void;
  onImportFile: () => void;
  onSave: () => void;
}) {
  return (
    <div className="scai-overlay" data-testid="template-parse-modal" role="dialog" aria-modal="true" aria-label={zh ? '模板识别' : 'Template recognition'}>
      <div className="scai-dialog">
        <header className="scai-dialog__head">
          <h2>{zh ? '模板识别（论文结构）' : 'Template recognition (paper structure)'}</h2>
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} aria-label={zh ? '关闭' : 'Close'}><X size={14} aria-hidden="true" /></button>
        </header>
        <div className="scai-dialog__body">
          <div className="personalization-template__panel" data-testid="template-parse-panel">
            <p>{zh ? '粘贴论文写作模板，或上传模板文件（txt/md/docx/pdf），AI 会解析为逐节写作指引，你可修改后保存为论文结构，供自主科研使用。' : 'Paste a paper template or upload a template file (txt/md/docx/pdf). AI parses it into per-section writing guides you can edit and save as a paper structure for autonomous research.'}</p>
            <label>
              <span>{zh ? '模板文本' : 'Template text'}</span>
              <textarea rows={3} value={text} onChange={(event) => onTextChange(event.target.value)} data-testid="template-parse-input" placeholder={zh ? '粘贴模板文本…' : 'Paste template text…'} />
            </label>
            <div className="personalization-ai-create__actions">
              <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={onImportFile} data-testid="template-upload-file">
                <Upload size={13} aria-hidden="true" /> {zh ? '上传文件' : 'Upload file'}
              </button>
              <button type="button" className="btn-primary btn-sm" disabled={busy || text.trim().length < 10} onClick={onParse} data-testid="template-parse-submit">
                {busy ? (zh ? '解析中…' : 'Parsing…') : (zh ? '解析模板' : 'Parse template')}
              </button>
            </div>
            {sections.length > 0 && (
              <div className="personalization-template__sections" data-testid="template-parse-sections">
                <label>
                  <span>{zh ? '结构名称' : 'Structure name'}</span>
                  <input className="settings-input" value={name} onChange={(event) => onNameChange(event.target.value)} data-testid="template-name-input" />
                </label>
                {sections.map((section, index) => (
                  <div key={index} className="personalization-template__section" data-testid="template-section">
                    <input
                      className="settings-input"
                      value={section.title}
                      aria-label={zh ? `第 ${index + 1} 节标题` : `Section ${index + 1} title`}
                      onChange={(event) => onUpdateSection(index, 'title', event.target.value)}
                    />
                    <textarea
                      rows={2}
                      value={section.instruction}
                      aria-label={zh ? `第 ${index + 1} 节写作指引` : `Section ${index + 1} writing guide`}
                      onChange={(event) => onUpdateSection(index, 'instruction', event.target.value)}
                    />
                    <button type="button" className="btn-secondary btn-sm" onClick={() => onRemoveSection(index)}>
                      {zh ? '删除' : 'Remove'}
                    </button>
                  </div>
                ))}
                <div className="personalization-ai-create__actions">
                  <button type="button" className="btn-primary btn-sm" disabled={!name.trim()} onClick={onSave} data-testid="template-save">
                    {zh ? '保存为论文结构' : 'Save as paper structure'}
                  </button>
                </div>
              </div>
            )}
            {status && <p className="personalization-ai-create__status" role="status" aria-live="polite" data-testid="template-parse-status">{status}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
