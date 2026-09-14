import { Bot, History, LoaderCircle, Plus, Send, Sparkles, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type OutcomeDetail, type OutcomeDocument, type OutcomeSource } from '../../../engine/runtime/OutcomeRuntimeContract';
import { RevisionProposalCard } from '../../outcomes/RevisionProposalCard';
import { autoResizeTextarea } from '../../lib/textareaAutosize.js';
import ModelThinkingSelector from '../../components/ModelThinkingSelector';
import { presentOutcomeAssistantAnswer, scrubPresentationProtocol } from '../../presentation/presentationProtocolScrubber';
import { assistantBridge, type AssistantApplied, type AssistantResult, type AssistantSelection, type ConversationUnit, requestSelection, type ScopedMessage } from './shared';

function mergeMessages(previous: ScopedMessage[], additions: Array<ScopedMessage | undefined>): ScopedMessage[] { const rows = new Map(previous.map((message) => [message.id, message])); additions.forEach((message) => { if (message?.id) rows.set(message.id, message); }); return [...rows.values()].sort((left, right) => left.createdAt - right.createdAt); }
const sourceKindLabel = (kind: string): string => ({
  selection: '当前选区', outcome_version: '成果版本', source: '项目资料', evidence: '证据', note_code: '笔记编码', claim: '论断', artifact: '项目产物', project_metis: '项目 METIS', upload: '上传文件',
}[kind] ?? kind);
const selectionContextLabel = (selection: AssistantSelection): string => {
  if (!selection) return '未附加局部选区';
  if (selection.kind === 'word') {
    const target = selection.row !== undefined && selection.column !== undefined
      ? `Word 表格 ${selection.blockId} 第 ${selection.row + 1} 行第 ${selection.column + 1} 列`
      : `Word 段落 ${selection.blockId}`;
    return selection.start !== undefined && selection.end !== undefined
      ? `${target}，字符 ${selection.start}–${selection.end}`
      : target;
  }
  return selection.elementId ? `PPT 页面 ${selection.pageId}，元素 ${selection.elementId}` : `PPT 页面 ${selection.pageId}`;
};
const selectedCharacterCount = (selection: AssistantSelection): number | undefined => selection?.kind === 'word' && selection.start !== undefined && selection.end !== undefined
  ? Math.max(0, selection.end - selection.start) : undefined;
function OutcomeSourceList({ sources, label, onOpenOutcomeVersion, onLocate }: { sources: readonly OutcomeSource[]; label: string; onOpenOutcomeVersion?: (source: OutcomeSource) => void; onLocate?: (source: OutcomeSource) => void }) {
  const locatable = (kind: string): boolean => kind === 'artifact' || kind === 'project_metis' || kind === 'outcome_version';
  return <section className="outcome-source-list" aria-label={label}>
    <small>{label}</small>
    {sources.length === 0 ? <p>无额外资料</p> : <ul>{sources.map((source, index) => <li key={`${source.kind}-${source.id}-${source.version ?? 'none'}-${index}`}>
      <strong>{source.label}</strong>
      <span>类型：{sourceKindLabel(source.kind)}（{source.kind}）{source.version !== undefined ? ` · v${source.version}` : ''}</span>
      {source.kind === 'outcome_version' && source.version !== undefined && onOpenOutcomeVersion && <button type="button" onClick={() => onOpenOutcomeVersion(source)} aria-label={`打开来源成果 ${source.label}`}>打开成果版本</button>}
      {locatable(source.kind) && onLocate && <button type="button" onClick={() => onLocate(source)} aria-label={`定位来源 ${source.label}`}>定位</button>}
    </li>)}</ul>}
  </section>;
}

function OutcomeAssistant({ projectId, projectName, detail, selection, hasUnsavedChanges, historyRevision, onOpenOutcomeVersion, onLocate, onApplied, onConversationChanged, onDraftContentUpdated }: { projectId: string; projectName: string; detail: OutcomeDetail | null; selection: AssistantSelection; hasUnsavedChanges: boolean; historyRevision: number; onOpenOutcomeVersion: (source: OutcomeSource) => void; onLocate?: (source: OutcomeSource) => void; onApplied: (applied: AssistantApplied | undefined) => void; onConversationChanged: () => void; onDraftContentUpdated?: (content: OutcomeDocument) => void }) {
  const [proposedBundle, setProposedBundle] = useState<{ set: { id: string; instruction: string; createdBy: string; status: 'pending' | 'partially_accepted' | 'accepted' | 'rejected' | 'stale' | 'cancelled' }; revisions: never[] } | undefined>(undefined);
  const [messages, setMessages] = useState<ScopedMessage[]>([]);
  const [instruction, setInstruction] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [notice, setNotice] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  // 会话单元管理：列表 / 只读浏览 / 新建与删除（桥接缺失时自动退回单历史视图）。
  const [conversations, setConversations] = useState<ConversationUnit[]>([]);
  const [browsing, setBrowsing] = useState<{ unit: ConversationUnit; messages: ScopedMessage[] } | null>(null);
  const resetOnNextLoadRef = useRef(false);
  const instructionRef = useRef<HTMLTextAreaElement>(null);
  // 任务5(2026-09-05):AI Profile 选择器——该成果绑定 Office Profile(正式持久化)。
  const [officeProfiles, setOfficeProfiles] = useState<Array<{ id: string; name: string; builtin: boolean }>>([]);
  const [boundProfileId, setBoundProfileId] = useState<string | null>(null);
  const outcomeKindForProfiles = detail?.outcome.kind === 'ppt' ? 'ppt' : 'word';
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const rows = await window.metis?.officePromptProfiles?.(outcomeKindForProfiles);
        if (alive && Array.isArray(rows)) setOfficeProfiles(rows.map((profile) => ({ id: profile.id, name: profile.name, builtin: profile.builtin })));
      } catch { /* profile 列表不可用时不阻塞助手 */ }
    })();
    return () => { alive = false; };
  }, [outcomeKindForProfiles]);
  useEffect(() => {
    if (!detail?.outcome.id || !window.metis?.officePromptProfiles) return;
    let alive = true;
    void (async () => {
      try {
        const rows = await window.metis?.officePromptProfiles?.(outcomeKindForProfiles);
        if (!alive || !Array.isArray(rows)) return;
        // T8 假配置修复：binding 从 office_prompt_outcome_bindings 表读取真值回显。
        const boundId = await window.metis?.officePromptGetBinding?.(detail.outcome.id);
        if (alive && typeof boundId === 'string' && boundId) setBoundProfileId(boundId);
      } catch { /* best-effort */ }
    })();
    return () => { alive = false; };
  }, [detail?.outcome.id, outcomeKindForProfiles]);
  // 指令框随内容自动增高，最多约 10 行，超出后内部滚动。
  useEffect(() => {
    if (instructionRef.current) autoResizeTextarea(instructionRef.current);
  }, [instruction]);
  const outcomeId = detail?.outcome.id;
  useEffect(() => {
    if (!historyOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setHistoryOpen(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [historyOpen]);

  useEffect(() => {
    let current = true;
    if (!outcomeId || !window.metis) { void Promise.resolve().then(() => { if (current) setMessages([]); }); return () => { current = false; }; }
    void window.metis.listScopedConversation({ projectId, scope: 'outcome', outcomeId, scenarioId: null })
      .then((rows: ScopedMessage[]) => {
        if (!current) return;
        const next = (rows ?? []).map((message: ScopedMessage) => ({
          ...(message as ScopedMessage),
          content: message.role === 'assistant' ? presentOutcomeAssistantAnswer(message.content) : message.content,
        })) as ScopedMessage[];
        // 新建/删除会话后，主面板必须以最新会话为准整体替换，而不是合并旧记录。
        if (resetOnNextLoadRef.current) { resetOnNextLoadRef.current = false; setMessages(next); }
        else setMessages((previous) => mergeMessages(previous, next));
      });
    return () => { current = false; };
  }, [historyRevision, outcomeId, projectId]);

  const loadConversations = useCallback(async () => {
    const units = assistantBridge()?.outcomesConversationUnits;
    if (!units || !outcomeId) { setConversations([]); return; }
    try { setConversations((await units({ projectId, outcomeId })) ?? []); } catch { setConversations([]); }
  }, [outcomeId, projectId]);

  useEffect(() => {
    let current = true;
    void Promise.resolve().then(() => { if (current) return loadConversations(); });
    return () => { current = false; };
  }, [loadConversations, historyRevision]);

  const startNewConversation = async () => {
    const create = assistantBridge()?.outcomesConversationCreate;
    if (!create || !detail || isSending) return;
    try {
      const created = await create({ projectId, outcomeId: detail.outcome.id });
      if (!created?.id) { setNotice('未能新建对话；当前协作历史保持不变。'); return; }
      // 新会话立即成为持久化目标（仓储按最近更新选择）；本地同步清空等待第一条消息。
      setMessages([]);
      setBrowsing(null);
      resetOnNextLoadRef.current = true;
      await loadConversations();
      onConversationChanged();
    } catch { setNotice('新建对话未完成；当前协作历史保持不变。'); }
  };

  const removeConversation = async (unitId: string) => {
    const remove = assistantBridge()?.outcomesConversationDelete;
    if (!remove || !detail || isSending) return;
    try {
      const removed = await remove({ projectId, conversationId: unitId });
      if (!removed) { setNotice('删除未完成：该会话不存在或不属于当前项目。'); return; }
      setBrowsing((current) => (current?.unit.id === unitId ? null : current));
      resetOnNextLoadRef.current = true;
      await loadConversations();
      onConversationChanged();
    } catch { setNotice('删除未完成，请重试。'); }
  };

  const browseConversation = async (unit: ConversationUnit) => {
    const byId = assistantBridge()?.outcomesConversationById;
    if (!byId || isSending) return;
    try {
      const rows = ((await byId({ projectId, conversationId: unit.id })) ?? []) as ScopedMessage[];
      setBrowsing({ unit, messages: rows });
    } catch { setNotice('无法载入该会话的记录。'); }
  };

  const loadDraftIntoEditor = async () => {
    if (!projectId || !detail) return;
    try {
      const draft = await window.metis?.outcome2DraftGet?.({ projectId, outcomeId: detail.outcome.id }) as { content?: OutcomeDocument } | null;
      if (draft?.content && onDraftContentUpdated) onDraftContentUpdated(draft.content);
    } catch { /* 读取失败保持当前编辑器内容 */ }
  };

  // T05.05：把 AI 回答原文作为新段落追加到文末——生成 Revision 提案（不直接写文档）。
  const appendAnswerAsRevision = async (answer: string, sources: OutcomeSource[]) => {
    if (!projectId || !detail || !window.metis?.outcome2RevisionCreate) return;
    const text = answer.trim();
    if (!text) return;
    const workbench = undefined; // 提案经 IPC 由主进程 Workbench 处理（Runtime 计算 beforeHash）。
    void workbench;
    try {
      const draft = await window.metis.outcome2DraftGet?.({ projectId, outcomeId: detail.outcome.id }) as { content?: OutcomeDocument } | null;
      if (!draft?.content || draft.content.type !== 'word') { setNotice('「加入成果」当前仅支持 Word 成果；其他类型未被改动。'); return; }
      const lastBlockId = draft.content.blocks.at(-1)?.id;
      if (!lastBlockId) { setNotice('文档为空，无法确定插入位置。'); return; }
      // 以文末块为锚：after = 文末块文本追加新段内容（服务端 apply 时按块替换）。
      const lastText = draft.content.blocks.at(-1)!.text ?? '';
      const proposalText = `${lastText}

${text}`;
      const created = await window.metis.outcome2RevisionCreate({
        projectId, outcomeId: detail.outcome.id,
        instruction: '把 AI 回答加入成果（文末追加）',
        createdBy: 'conversation',
        proposals: [{ target: { kind: 'word_block', blockId: lastBlockId }, after: { text: proposalText }, reason: '把本轮 AI 回答追加到文末', sourceRefs: sources }],
      });
      if (created?.ok) {
        setProposedBundle(created.value as typeof proposedBundle);
        setNotice('已生成「加入成果」修订提案（文末追加）。接受后写入工作草稿，仍需保存版本才会进入版本历史。');
      } else {
        setNotice(`加入成果未完成：${created?.code ?? 'unknown'}`);
      }
    } catch { setNotice('加入成果未完成，正文未被改动。'); }
  };

  const send = async () => {
    if (!detail || !instruction.trim() || isSending) return;
    if (hasUnsavedChanges) { setNotice('当前成果有未保存的编辑。请先保存为新版本，再让 AI 协同，避免覆盖本地草稿。'); return; }
    const chat = assistantBridge()?.chatOutcomeAssistant;
    if (!chat) { setNotice('成果 AI 运行服务尚未就绪，未发送也未创建任何修改。'); return; }
    setIsSending(true); setNotice('');
    try {
      const scopedSelection = requestSelection(selection);
      const result: AssistantResult = await chat({ projectId, outcomeId: detail.outcome.id, instruction: scrubPresentationProtocol(instruction.trim()), ...(scopedSelection ? { selection: scopedSelection } : {}) });
      setInstruction('');
      if (result.status === 'completed') {
        setMessages((previous) => mergeMessages(previous, [
          result.userMessage,
          { ...result.assistantMessage, content: presentOutcomeAssistantAnswer(result.assistantMessage.content) },
        ]));
        onConversationChanged();
        if (result.proposed) {
          // Outcomes 2.0（T05.04）：对话回答可直接生成修改建议（Revision Set），不写版本。
          setProposedBundle(result.proposed as { set: { id: string; instruction: string; createdBy: string; status: 'pending' | 'partially_accepted' | 'accepted' | 'rejected' | 'stale' | 'cancelled' }; revisions: never[] });
          setNotice('已根据本轮回答生成修改建议（未改动正文，未创建版本）。请核对后接受或拒绝；也可把回答原文加入成果。');
          return;
        }
        if (result.applied) { onApplied(result.applied); setNotice('AI 已将经过校验的修改保存为新版本；你可在版本面板随时回退。'); }
        else setNotice('AI 已回复。本轮没有生成可安全应用的结构化修改，因此成果内容未被改动。');
        return;
      }
      const failed = result as unknown as { status: 'error' | 'cancelled'; code?: string; message?: string; userMessage?: ScopedMessage };
      setMessages((previous) => mergeMessages(previous, failed.userMessage ? [{ ...failed.userMessage, content: scrubPresentationProtocol(failed.userMessage.content) }] : []));
      if (failed.userMessage) onConversationChanged();
      setNotice(failed.message || `本次协同未完成：${failed.code || failed.status}`);
    } catch { setNotice('成果 AI 请求没有完成，成果内容没有被修改。'); }
    finally { setIsSending(false); }
  };

  return <aside className="outcome-assistant" aria-label="AI 成果助手">
    <header className="outcome-assistant__header"><span className="outcome-assistant__mark"><Sparkles size={16} /></span><div><h2>AI 成果助手</h2><p>项目《{projectName}》</p></div><button type="button" className="outcome-assistant__history-btn" onClick={() => setHistoryOpen(true)} disabled={!detail} title={detail ? '查看成果协作历史' : '先打开一个成果，即可查看与它的协作历史'} aria-label="查看成果协作历史"><History size={15} />历史记录</button></header>
    {detail && officeProfiles.length > 0 && (
      <div className="outcome-assistant__profile-row" aria-label="AI Profile">
        <span>AI Profile</span>
        <select
          aria-label="选择 AI Profile"
          value={boundProfileId ?? ''}
          onChange={(event) => {
            const profileId = event.target.value || null;
            setBoundProfileId(profileId);
            void window.metis?.officePromptBindOutcome?.({ outcomeId: detail.outcome.id, profileId });
          }}
          data-testid="assistant-profile-select"
        >
          <option value="">格式默认</option>
          {officeProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}{profile.builtin ? '(内置)' : ''}</option>)}
        </select>
      </div>
    )}
    {!detail ? <div className="outcome-assistant__empty"><Bot size={24} /><h3>打开成果后开始协作</h3><p>助手仅绑定当前项目和成果；实际使用的资料会逐条显示在协作记录下方。</p></div> : <>
      <section className="outcome-assistant__context" aria-label="当前上下文">
        <strong>当前上下文</strong>
        <ul><li>项目：{projectName}</li><li>成果：{detail.outcome.title}</li><li>版本：v{detail.version.version}</li><li><span>选区：</span><span>{selectionContextLabel(selection)}</span>{selectedCharacterCount(selection) !== undefined && <span>，<b>已选 {selectedCharacterCount(selection)} 个字符</b></span>}</li></ul>
        <p>这里只显示当前状态；每轮实际使用的资料以对应协作记录为准。</p>
      </section>
      <div className="outcome-assistant__messages" aria-live="polite">
        {messages.length === 0 ? <div className="outcome-assistant__starter"><p>可以直接说：</p><button type="button" onClick={() => setInstruction('检查当前成果的结构、论证和表达问题，并给出可直接应用的修改。')}>检查当前成果</button><button type="button" onClick={() => setInstruction('根据当前项目已有资料，改进当前选中的内容。')}>根据项目资料修改</button></div> : messages.slice(-8).map((message) => <article key={message.id} className={`outcome-assistant__message outcome-assistant__message--${message.role}`} aria-label={`${message.role === 'user' ? '用户' : message.role === 'assistant' ? 'METIS' : '系统'}协作记录`}><span>{message.role === 'user' ? '你' : message.role === 'assistant' ? 'METIS' : '系统'}</span><p>{message.role === 'assistant' ? presentOutcomeAssistantAnswer(message.content) : message.content}</p>{message.role === 'assistant' && detail && !hasUnsavedChanges && <button type="button" className="outcome-assistant__append-btn" data-testid={`append-answer-${message.id}`} title="把这段回答加入成果（生成修订提案，需确认后应用）" onClick={() => { void appendAnswerAsRevision(presentOutcomeAssistantAnswer(message.content), message.sources); }}>加入成果</button>}<OutcomeSourceList sources={message.sources} label="本条实际来源" onOpenOutcomeVersion={onOpenOutcomeVersion} onLocate={onLocate} /></article>)}
      </div>
      {proposedBundle && <RevisionProposalCard projectId={projectId} set={proposedBundle.set} revisions={proposedBundle.revisions} onDraftUpdated={(content) => { if (content && onDraftContentUpdated) onDraftContentUpdated(content as OutcomeDocument); else void loadDraftIntoEditor(); }} onNotice={setNotice} />}
      {notice && <p className="outcome-assistant__notice" role="status">{notice}</p>}
      <div className="outcome-assistant__composer"><textarea ref={instructionRef} value={instruction} onChange={(event) => setInstruction(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send(); } }} placeholder="例如：根据项目中的实验结果重写当前段落" disabled={isSending} /><div className="outcome-assistant__composer-tools" data-testid="outcome-assistant-toolbar"><ModelThinkingSelector zh={true} disabled={isSending} /><span style={{ flex: 1 }} /><span>Ctrl / ⌘ + Enter 发送</span><button className="primary" type="button" onClick={() => void send()} disabled={isSending || !instruction.trim()}>{isSending ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}发送</button></div></div>
    </>}
    {historyOpen && detail && <ConversationHistoryDialog messages={messages} title={`${detail.outcome.title} · 协作历史`} close={() => setHistoryOpen(false)} onOpenOutcomeVersion={onOpenOutcomeVersion} onLocate={onLocate} conversations={conversations} browsing={browsing} managementAvailable={Boolean(assistantBridge()?.outcomesConversationCreate && assistantBridge()?.outcomesConversationDelete)} onBrowse={(unit) => void browseConversation(unit)} onBackToCurrent={() => setBrowsing(null)} onNewConversation={() => void startNewConversation()} onDeleteConversation={(unitId) => void removeConversation(unitId)} />}
  </aside>;
}
function ConversationHistoryDialog({ messages, title, close, onOpenOutcomeVersion, onLocate, conversations, browsing, managementAvailable, onBrowse, onBackToCurrent, onNewConversation, onDeleteConversation }: { messages: ScopedMessage[]; title: string; close: () => void; onOpenOutcomeVersion: (source: OutcomeSource) => void; onLocate?: (source: OutcomeSource) => void; conversations: ConversationUnit[]; browsing: { unit: ConversationUnit; messages: ScopedMessage[] } | null; managementAvailable: boolean; onBrowse: (unit: ConversationUnit) => void; onBackToCurrent: () => void; onNewConversation: () => void; onDeleteConversation: (unitId: string) => void }) {
  const visible = browsing ? browsing.messages : messages;
  return <div className="outcomes-modal-backdrop" role="presentation"><section className="outcomes-modal outcome-history-dialog" role="dialog" aria-modal="true" aria-label="成果协作历史"><header><div><strong>{title}</strong><small>历史由当前项目与成果共同保存；每条记录仅展示其持久化的实际来源。</small></div><button type="button" onClick={close} aria-label="关闭"><X size={16} /></button></header>
    {managementAvailable && <div className="outcome-history-dialog__manager">
      <div className="outcome-history-dialog__toolbar"><button type="button" className="primary" onClick={onNewConversation}><Plus size={13} />新对话</button><small>发送下一条消息时会保存到最新对话；删除仅移除所选对话。</small></div>
      {conversations.length > 0 && <ul className="outcome-history-dialog__units">
        {conversations.map((unit, index) => <li key={unit.id} className={browsing?.unit.id === unit.id ? 'active' : ''}>
          <button type="button" onClick={() => onBrowse(unit)} aria-label={`查看对话 ${unit.title || '未命名对话'}`}>
            <b>{index === 0 ? '当前 · ' : ''}{unit.title || '未命名对话'}</b>
            <span>{new Date(unit.updatedAt).toLocaleString()} · {unit.messageCount} 条</span>
          </button>
          <button type="button" onClick={() => onDeleteConversation(unit.id)} aria-label={`删除对话 ${unit.title || '未命名对话'}`} title="删除该对话"><Trash2 size={13} /></button>
        </li>)}
      </ul>}
    </div>}
    <p className="outcome-history-dialog__scope">{browsing ? `正在查看历史对话「${browsing.unit.title || '未命名对话'}」（只读）。` : '以下为当前对话记录。'}</p>
    <div className="outcome-history-dialog__messages">{visible.length === 0 ? <p>{browsing ? '该会话没有已保存的记录。' : '还没有已保存的协作记录。'}</p> : visible.map((message) => <article key={message.id}><b>{message.role === 'user' ? '你' : message.role === 'assistant' ? 'METIS' : '系统'}</b><time>{new Date(message.createdAt).toLocaleString()}</time><p>{message.role === 'assistant' ? presentOutcomeAssistantAnswer(message.content) : message.content}</p><OutcomeSourceList sources={message.sources} label="本条实际来源" onOpenOutcomeVersion={onOpenOutcomeVersion} onLocate={onLocate} /></article>)}</div><footer>{browsing && <button type="button" onClick={onBackToCurrent}>返回当前对话</button>}<button className="primary" type="button" onClick={close}>返回成果助手继续协作</button></footer></section></div>;
}

export { OutcomeAssistant };
