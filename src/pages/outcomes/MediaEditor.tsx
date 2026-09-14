import { Download, FileSpreadsheet, Image as ImageIcon, LoaderCircle, Save, Sparkles, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { type OutcomeDocument, type OutcomeKind, type OutcomeMedia } from '../../../engine/runtime/OutcomeRuntimeContract';
import { imageGenerationFailureNotice } from './shared';

function MediaEditor({ projectId, outcomeId, kind, hasUnsavedChanges, document, onChange, onSave }: { projectId: string; outcomeId: string; kind: OutcomeKind; hasUnsavedChanges: boolean; document: Extract<OutcomeDocument, { type: 'other' | 'spreadsheet' | 'pdf' }>; onChange: (value: Extract<OutcomeDocument, { type: 'other' | 'spreadsheet' | 'pdf' }>) => void; onSave: (value: Extract<OutcomeDocument, { type: 'other' | 'spreadsheet' | 'pdf' }>, note: string, actor?: 'human' | 'import') => void }) {
  const [preview, setPreview] = useState<{ mediaId: string; url: string | null } | null>(null); const [prompt, setPrompt] = useState(''); const [quality, setQuality] = useState<'standard' | 'hd' | 'low' | 'medium' | 'high'>('standard'); const [notice, setNotice] = useState(''); const [isGenerating, setIsGenerating] = useState(false); const generationInFlight = useRef(false); const media = document.media; const url = media && preview?.mediaId === media.id ? preview.url : null;
  useEffect(() => { let current = true; if (!media || !window.metis?.readOutcomeMedia) return () => { current = false; }; void window.metis.readOutcomeMedia({ projectId, outcomeId, mediaId: media.id }).then((value) => { if (current) setPreview({ mediaId: media.id, url: typeof value === 'string' ? value : null }); }).catch(() => { if (current) setPreview({ mediaId: media.id, url: null }); }); return () => { current = false; }; }, [media, projectId, outcomeId]);
  const importFile = async () => { const value = await window.metis?.importOutcomeMedia({ projectId, outcomeId }) as OutcomeMedia | null; if (value) onSave({ ...document, media: value }, `导入 ${value.displayName}`, 'import'); };
  const exportSvgFile = async () => {
    if (!media || media.mediaType !== 'image/svg+xml') return;
    const exportBridge = window.metis?.exportOutcomeMediaSvg;
    if (!exportBridge) { setNotice('当前版本缺少 SVG 导出桥接；本次没有写出文件。'); return; }
    setNotice('正在导出安全 SVG 副本…');
    try {
      const result = await exportBridge({ projectId, outcomeId, mediaId: media.id });
      setNotice(result.ok ? `已导出 ${result.fileName}；导出副本经过独立安全校验。` : result.message);
    } catch { setNotice('SVG 导出请求没有完成；当前成果没有被修改。'); }
  };
  const generate = async () => {
    if (generationInFlight.current || isGenerating) return;
    if (hasUnsavedChanges) { setNotice('当前图片成果有未保存的编辑。请先保存版本，再生成新图片，避免覆盖本地草稿。'); return; }
    if (!prompt.trim()) { setNotice('请输入图片生成提示词。'); return; }
    const generateImage = window.metis?.generateOutcomeImage;
    if (!generateImage) { setNotice('图片生成运行服务尚未就绪；本次没有生成图片。'); return; }
    generationInFlight.current = true; setIsGenerating(true); setNotice('正在请求图片生成服务；返回前不会修改当前成果版本。');
    try {
     const description = document.type === 'other' ? document.text.trim() : '';
     const result = await generateImage({ projectId, outcomeId, prompt: prompt.trim(), visualContext: `成果类型：图片。${description ? `成果说明：${description}` : '当前没有额外文字说明。'}${media ? ` 当前媒体：${media.displayName}。` : ''}`, quality });
      if (!result.ok) { setNotice(imageGenerationFailureNotice(result.code)); return; }
      onChange({ ...document, media: result.media }); setPrompt(''); setNotice(`已收到并引用真实持久化图片「${result.media.displayName}」。预览加载后，请点击“保存图片版本”使其成为不可变版本。`);
    } catch { setNotice('图片生成请求没有完成，当前成果没有被修改。'); }
    finally { generationInFlight.current = false; setIsGenerating(false); }
  };
  return <div className="outcome-media-preview"><header><strong>{media?.displayName ?? (kind === 'image' ? 'AI 图片成果' : kind === 'spreadsheet' ? 'Excel 成果' : kind === 'pdf' ? 'PDF 成果' : '其他正式交付物')}</strong><div><button type="button" onClick={() => void importFile()}><Upload size={15} />{media ? '替换文件' : '导入文件'}</button>{media?.mediaType === 'image/svg+xml' && <button type="button" onClick={() => void exportSvgFile()}><Download size={15} />导出 SVG</button>}{(kind === 'image' || kind === 'spreadsheet' || kind === 'pdf') && <button className="primary" type="button" onClick={() => onSave(document, `保存${kind === 'image' ? '图片' : kind === 'spreadsheet' ? 'Excel' : 'PDF'}成果`, 'human')} disabled={!media || !hasUnsavedChanges}><Save size={15} />保存版本</button>}</div></header>{kind === 'image' && <section className="outcome-image-generator" aria-label="AI 生成图片"><header><div><strong>AI 生成图片</strong><small>仅使用主进程已持久化到当前成果媒体区的图片；不会在前端伪造文件。</small></div></header><label>图片提示词<textarea aria-label="图片生成提示词" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="例如：用于研究报告封面的克制蓝色数据可视化插图" disabled={isGenerating || hasUnsavedChanges} /></label><label>质量<select aria-label="图片生成质量" value={quality} onChange={(event) => setQuality(event.target.value as typeof quality)} disabled={isGenerating || hasUnsavedChanges}><option value="standard">标准</option><option value="hd">高清</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label><button className="primary" type="button" onClick={() => void generate()} disabled={isGenerating || hasUnsavedChanges || !prompt.trim()}>{isGenerating ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}生成图片</button>{hasUnsavedChanges && <p role="status">当前有未保存图片草稿；先保存版本后才能生成，避免覆盖编辑。</p>}{isGenerating && <p role="status">生成中。当前桥接未提供取消请求能力，不能伪称已取消。</p>}{notice && <p role="status">{notice}</p>}</section>}{!media ? <div className="outcomes-empty"><ImageIcon size={32} /><p>{kind === 'image' ? '输入提示词即可请求真实图片生成，或导入 PNG、JPEG、SVG。生成结果需手动保存为成果版本。' : kind === 'spreadsheet' ? '导入真实 XLSX 后，可在 Metis Office 中使用原生 Excel 网格编辑。' : kind === 'pdf' ? '导入真实 PDF 后，可在 Metis Office 中使用原生 PDF 页面编辑。' : '支持 PDF、PNG、JPEG 和安全 SVG；文件仅存入当前项目的成果私有媒体区。'}</p></div> : media.mediaType === 'application/pdf' && url ? <iframe title={media.displayName} className="outcome-pdf-frame" sandbox="allow-same-origin" src={url} /> : media.mediaType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ? <div className="outcome-document-file"><FileSpreadsheet size={36} /><strong>{media.displayName}</strong><span>真实 XLSX 文件已托管；点击“Metis Office”进入原生表格编辑。</span></div> : url ? <figure className="outcome-image-frame"><img src={url} alt={media.displayName} /><figcaption>{media.displayName}</figcaption></figure> : <div className="outcomes-empty">预览加载中或完整性校验未通过。</div>}</div>;
}

export { MediaEditor };
