import React from 'react';
import { AssistantTurn, UserTurn } from '../conversation/ConversationTurns';
import { SafeMarkdown } from '../presentation/SafeMarkdown';
import { ChevronRight, Plus } from 'lucide-react';
import './TopicWorkspacePage.css';
import type { TopicCandidateDto, TopicResearchBrief, TopicSessionDto } from '../../engine/runtime/TopicRuntimeContract.js';
import { researchWorkspaceStore } from '../research/researchWorkspaceStore.js';
import { setPendingScenarioHandoff } from '../topic/scenarioHandoff.js';
import ChatbotCollabPanel from '../topic/ChatbotCollabPanel';
import SplitHandle from '../components/SplitHandle';
import { buildTopicContextPackage } from '../topic/contextPackage';
import type { ExternalModelReference } from '../../engine/runtime/ExternalReferenceContract.js';

/**
 * 选题 Topic Workspace(2026-09-04 刘总要求:选题一级功能)。
 * 三栏:左=选题会话;中=AI 研究过程(真实检索/研究版图/结构化选择);右=候选池(可折叠)。
 * 复用 METIS 桌面工作台设计(高信息密度、克制、无卡片墙/评分圆环)。
 */

const SESSION_STATUS_LABELS: Record<string, string> = {
  exploring: '意向确认中', researching: '检索研究中', comparing: '候选比较中',
  selected: '选题已确定', converted: '已转项目', archived: '已归档',
};

const CANDIDATE_STATUS_LABELS: Record<string, string> = {
  candidate: '候选', shortlisted: '已收藏', selected: '已选定', rejected: '已排除', converted: '已转项目',
};

interface TopicStreamChunk { sessionId: string; content: string; reasoning?: string; isFinished: boolean }

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function EvidenceList({ refs }: { refs: TopicCandidateDto['evidenceRefs'] }) {
  if (refs.length === 0) return null;
  return (
    <ul className="topic-evidence">
      {refs.slice(0, 6).map((ref, index) => (
        <li key={`${ref.title}-${index}`}>
          {ref.title}
          {ref.authors && ref.authors.length > 0 ? `(${ref.authors.slice(0, 3).join(',')}${ref.authors.length > 3 ? '等' : ''})` : ''}
          {ref.year ? ` ${ref.year}` : ''}
          {ref.venue ? `·${ref.venue}` : ''}
          {ref.url ? <a href={ref.url} target="_blank" rel="noreferrer"> 链接</a> : ref.doi ? <span> DOI:{ref.doi}</span> : null}
          {ref.claim ? <small> 支持:{ref.claim}</small> : null}
        </li>
      ))}
      {refs.length > 6 && <li>{`等 ${refs.length} 条证据`}</li>}
    </ul>
  );
}

export default function TopicWorkspacePage() {
  const [sessions, setSessions] = React.useState<TopicSessionDto[]>([]);
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(null);
  const [session, setSession] = React.useState<TopicSessionDto | null>(null);
  const [candidates, setCandidates] = React.useState<TopicCandidateDto[]>([]);
  const [messages, setMessages] = React.useState<Array<{ id: string; role: string; content: string }>>([]);
  const [input, setInput] = React.useState('');
  const [streaming, setStreaming] = React.useState(false);
  const [streamTail, setStreamTail] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const [newIntent, setNewIntent] = React.useState('');
  const [rightCollapsed, setRightCollapsed] = React.useState(false);
  const [activeCandidateId, setActiveCandidateId] = React.useState<string | null>(null);
  const [projectCreating, setProjectCreating] = React.useState(false);
  // Chatbot 协作视图（2026-09-05 刘总规格书）：临时双栏，关闭即退出嵌入。
  const [chatbotOpen, setChatbotOpen] = React.useState(false);
  const [externalRefs, setExternalRefs] = React.useState<ExternalModelReference[]>([]);
  const [chatbotSplit, setChatbotSplit] = React.useState<number>(() => {
    try {
      const value = Number(window.localStorage.getItem('metis-chatbot-split-v2'));
      return Number.isFinite(value) && value >= 0.4 && value <= 0.45 ? value : 0.42;
    } catch { return 0.42; }
  });
  const collabWrapRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    try { window.localStorage.setItem('metis-chatbot-split-v2', String(chatbotSplit)); } catch { /* best-effort */ }
  }, [chatbotSplit]);
  const applySplitFromClientX = React.useCallback((clientX: number) => {
    const rect = collabWrapRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const ratio = (rect.right - clientX) / rect.width;
    setChatbotSplit(Math.min(0.45, Math.max(0.4, ratio)));
  }, []);
  const syncChatbotBounds = React.useCallback(() => {
    // 松手后按新尺寸恢复嵌入视图（拖动期间已隐藏）。
    window.dispatchEvent(new CustomEvent('metis:restore-embedded-views'));
  }, []);
  const sessionIdRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    sessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const refreshExternalRefs = React.useCallback(async () => {
    try {
      const result = await window.metis?.externalRefList?.({ limit: 50 });
      if (result?.ok && result.references) setExternalRefs(result.references);
    } catch { /* 列表失败保留现状 */ }
  }, []);

  const refreshSessions = React.useCallback(async () => {
    try {
      const rows = await window.metis?.topicListSessions?.();
      setSessions((rows ?? []).filter((row): row is TopicSessionDto => Boolean(row && typeof (row as { id?: unknown }).id === 'string')));
    } catch { setSessions([]); }
  }, []);

  const loadSession = React.useCallback(async (id: string) => {
    try {
      const detail = await window.metis?.topicGetSession?.(id);
      if (!detail) return;
      setSession(detail.session as unknown as TopicSessionDto);
      setCandidates((detail.candidates ?? []) as unknown as TopicCandidateDto[]);
      setMessages((detail.messages ?? []).map((message) => ({ id: String((message as { id: string }).id), role: String((message as { role: string }).role), content: String((message as { content: string }).content) })));
    } catch { /* 加载失败保留当前状态 */ }
  }, []);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot session list load
    void refreshSessions();
    void refreshExternalRefs();
  }, [refreshSessions, refreshExternalRefs]);

  React.useEffect(() => {
    const unsubscribe = window.metis?.onTopicStreamChunk?.((chunk: TopicStreamChunk) => {
      if (chunk.sessionId !== sessionIdRef.current) return; // 事件按会话隔离
      setStreamTail(chunk.content.length > 400 ? chunk.content.slice(-400) : chunk.content);
    });
    return () => unsubscribe?.();
  }, []);

  const buildPackage = React.useCallback((): string | null => buildTopicContextPackage({
    hasSession: Boolean(session),
    sessionTitle: session?.title ?? null,
    sessionStatus: session ? (SESSION_STATUS_LABELS[session.status] ?? session.status) : null,
    candidates: candidates.map((candidate) => ({
      title: candidate.title,
      status: CANDIDATE_STATUS_LABELS[candidate.status] ?? candidate.status,
    })),
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    externalReferences: externalRefs.map((ref) => ({ model: ref.model, quotedText: ref.quotedText })),
  }), [session, candidates, messages, externalRefs]);

  const handleReferenceConfirmed = React.useCallback((reference: ExternalModelReference, duplicate: boolean) => {
    setExternalRefs((current) => current.some((item) => item.contextDigest === reference.contextDigest) ? current : [reference, ...current]);
    setMessages((current) => [...current, {
      id: `extref-${reference.id}`,
      role: 'assistant',
      content: [
        `外部参考·非证据｜来源：${reference.model}（${reference.url}）`,
        reference.quotedText.length > 600 ? `${reference.quotedText.slice(0, 600)}…` : reference.quotedText,
        duplicate ? '（内容指纹重复，未重复入库）' : '已存入外部参考库（external_references）。该内容不进入证据链，仅供选题论证参考。',
      ].join('\n'),
    }]);
  }, []);

  const createSession = async () => {
    const intent = newIntent.trim();
    if (!intent) return;
    const result = await window.metis?.topicCreateSession?.({ initialIntent: intent });
    if (result?.ok && result.session) {
      const session = result.session as unknown as TopicSessionDto;
      setCreating(false);
      setNewIntent('');
      await refreshSessions();
      setActiveSessionId(session.id);
      await loadSession(session.id);
      // 首条意图自动发起研究(不重复询问用户已给出的信息)。
      void sendFirstMessage(session.id, intent);
    } else {
      setNotice(result?.code === 'persistence_unavailable' ? '持久化暂不可用,无法创建选题会话。' : '创建选题会话失败,请重试。');
    }
  };

  const sendFirstMessage = async (id: string, intent: string) => {
    setStreaming(true);
    setStreamTail('');
    try {
      const result = await window.metis?.topicChat?.({ sessionId: id, message: intent });
      if (result?.ok) {
        await loadSession(id);
        setNotice('');
      } else {
        setNotice(`选题研究轮未完成:${result?.message ?? result?.code ?? '未知原因'}。已记录的内容已保留。`);
        await loadSession(id);
      }
    } finally {
      setStreaming(false);
      setStreamTail('');
    }
  };

  const send = async () => {
    const message = input.trim();
    if (!message || !activeSessionId || streaming) return;
    setInput('');
    setMessages((current) => [...current, { id: makeId('local'), role: 'user', content: message }]);
    setStreaming(true);
    setStreamTail('');
    try {
      const result = await window.metis?.topicChat?.({ sessionId: activeSessionId, message });
      if (result?.ok) {
        await loadSession(activeSessionId);
        setNotice('');
      } else {
        setNotice(`本轮未完成:${result?.message ?? result?.code ?? '未知原因'}。已收到的研究内容已保留,可直接重发或继续。`);
        await loadSession(activeSessionId);
      }
    } finally {
      setStreaming(false);
      setStreamTail('');
    }
  };

  const updateCandidateStatus = async (candidateId: string, status: 'shortlisted' | 'rejected' | 'candidate') => {
    if (!activeSessionId) return;
    await window.metis?.topicUpdateCandidate?.({ sessionId: activeSessionId, candidateId, patch: { status } });
    await loadSession(activeSessionId);
  };

  const confirmSelection = async (candidate: TopicCandidateDto) => {
    if (!activeSessionId) return;
    const result = await window.metis?.topicSelectCandidate?.({ sessionId: activeSessionId, candidateId: candidate.id });
    if (result?.ok) {
      await loadSession(activeSessionId);
      await refreshSessions();
      setNotice('选题已确认。可以基于选题构建场景,或直接创建科研项目。');
    } else {
      setNotice(`确认选题失败:${result?.code ?? '未知原因'}`);
    }
  };

  const activeCandidate = candidates.find((candidate) => candidate.id === activeCandidateId) ?? candidates.find((candidate) => candidate.status === 'selected') ?? null;
  const selectedCandidate = candidates.find((candidate) => candidate.status === 'selected') ?? null;

  const buildScenario = async () => {
    if (!selectedCandidate || !session) return;
    // 优先后端生成的正式结构化 Brief;不可用时回退为前端最小 Brief(不阻塞 handoff)。
    let brief: TopicResearchBrief;
    try {
      const stored = await window.metis?.topicGetBrief?.(session.id) as TopicResearchBrief | null | undefined;
      brief = stored ?? {
        source: 'topic', topicSessionId: session.id, candidateId: selectedCandidate.id,
        title: selectedCandidate.title, originalIntent: session.initialIntent,
        researchQuestion: selectedCandidate.researchQuestion, discipline: session.discipline,
        researchBackground: selectedCandidate.summary, rationale: selectedCandidate.rationale,
        literatureLandscape: '', mainResearchStreams: selectedCandidate.theoreticalAngles,
        majorDebates: [], researchGap: selectedCandidate.researchGap,
        closestStudies: selectedCandidate.closestStudies, theoreticalAngles: selectedCandidate.theoreticalAngles,
        methodologySuggestions: selectedCandidate.methodOptions, dataSuggestions: selectedCandidate.dataOptions,
        constraints: session.constraints, risks: selectedCandidate.risks,
        targetPublication: session.constraints?.targetPublications ?? [],
        evidenceRefs: selectedCandidate.evidenceRefs, userDecisions: '', createdAt: Date.now(),
      };
    } catch {
      return;
    }
    setPendingScenarioHandoff({ title: selectedCandidate.title, brief });
    window.dispatchEvent(new CustomEvent('metis:open-personalization'));
  };

  const createProjectDirectly = async () => {
    if (!selectedCandidate || !session || projectCreating) return;
    setProjectCreating(true);
    try {
      const projectId = `proj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const result = await researchWorkspaceStore.getState().createProject({
        projectId,
        title: selectedCandidate.title.slice(0, 120),
        originalIntent: session.initialIntent.slice(0, 4000),
        researchQuestion: selectedCandidate.researchQuestion.slice(0, 1500),
        methodology: selectedCandidate.methodOptions.join('、').slice(0, 800),
        discipline: session.discipline.slice(0, 100),
      });
      if (result.success && result.resourceId) {
        // Scenario 绑定:沿用当前项目创建的偏好写入方式(任务3多对话架构将正式化为 defaultScenarioId)。
        await window.metis?.topicMarkConverted?.({ candidateId: selectedCandidate.id, projectId: result.resourceId });
        researchWorkspaceStore.getState().setActiveProject(result.resourceId);
        window.dispatchEvent(new CustomEvent('metis:navigate-projects'));
        setNotice('科研项目已创建,已进入项目工作台。');
      } else {
        setNotice('科研项目创建失败。选题与场景数据均保留,可重试。');
      }
    } catch {
      setNotice('科研项目创建失败。选题与场景数据均保留,可重试。');
    } finally {
      setProjectCreating(false);
    }
  };

  const workspaceNode = (
    <div className={`topic-workspace${chatbotOpen ? ' topic-workspace--collab' : ''}`} data-testid="topic-workspace">
      <aside className="topic-workspace__sidebar" aria-label="选题会话">
        <header>
          <strong>选题</strong>
          <span className="topic-workspace__header-actions">
            <button type="button" className="btn-secondary btn-sm" onClick={() => setCreating((value) => !value)} data-testid="topic-new">
              <Plus size={13} /> 新选题
            </button>
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={() => setChatbotOpen(true)}
              data-testid="topic-open-chatbot"
              title="打开 Chatbot 协作面板：与其他 AI 并排讨论，内容仅作外部参考（非证据）"
            >
              打开 Chatbot
            </button>
          </span>
        </header>
        {creating && (
          <div className="topic-workspace__new">
            <textarea
              rows={4}
              value={newIntent}
              placeholder="例如:我想研究生成式人工智能对知识劳动者的影响,偏劳动社会学,想投 CSSCI,但具体题目还没想好。"
              onChange={(event) => setNewIntent(event.target.value)}
              data-testid="topic-new-intent"
            />
            <button type="button" className="btn-primary btn-sm" disabled={!newIntent.trim()} onClick={() => void createSession()} data-testid="topic-create-submit">开始选题研究</button>
          </div>
        )}
        <ul className="topic-workspace__sessions">
          {sessions.map((item) => (
            <li key={item.id} className={item.id === activeSessionId ? 'active' : undefined}>
              <button
                type="button"
                onClick={() => { setActiveSessionId(item.id); void loadSession(item.id); }}
                data-testid={`topic-session-${item.id}`}
              >
                <strong>{item.title}</strong>
                <small>{SESSION_STATUS_LABELS[item.status] ?? item.status}</small>
              </button>
            </li>
          ))}
          {sessions.length === 0 && <li className="topic-workspace__empty">还没有选题会话。点击「新选题」描述你的研究兴趣开始。</li>}
        </ul>
      </aside>

      <section className="topic-workspace__main" aria-label="选题研究过程">
        {session && (session.status === 'selected' || session.status === 'converted') && (
          <div className="topic-workspace__selected-banner" data-testid="topic-selected-banner">
            <span>选题已确定:《{selectedCandidate?.title ?? session.title}》</span>
            <span className="topic-workspace__banner-actions">
              <button type="button" className="btn-primary btn-sm" onClick={() => void buildScenario()} data-testid="topic-build-scenario">基于选题构建场景</button>
              <button type="button" className="btn-secondary btn-sm" disabled={projectCreating} onClick={() => void createProjectDirectly()} data-testid="topic-create-project">直接创建科研项目</button>
              <button type="button" className="btn-secondary btn-sm" onClick={() => window.metis?.topicUpdateSession?.({ sessionId: session.id, patch: { status: 'comparing' } }).then(() => loadSession(session.id))}>继续完善</button>
            </span>
          </div>
        )}
        {notice && <div className="topic-workspace__notice" role="status">{notice}</div>}
        <div className="topic-workspace__messages">
          {messages.length === 0 && !session && (
            <div className="topic-workspace__intro">
              <h2>选题</h2>
              <p>从一个模糊的研究兴趣开始:METIS 会先确认你的目标与条件,然后真实检索中文与英文研究,形成研究版图,与你一起比较、论证并收窄候选,最终确认选题并一路带进场景构建与科研项目。</p>
              <p className="topic-workspace__intro-note">每个研究判断尽可能附带真实来源;来源不可用会被如实告知,不会冒充"没有相关研究"。</p>
            </div>
          )}
          {messages.map((message) => (
            message.role === 'user'
              ? <UserTurn key={message.id} message={{ id: message.id, role: 'user', createdAt: 0, parts: [{ type: 'text', text: message.content }] }} />
              : <AssistantTurn key={message.id} message={{ id: message.id, role: 'assistant', createdAt: 0, parts: [{ type: 'text', text: message.content }] }} />
          ))}
          {streaming && (
            <div className="conv-assistant" data-status="streaming">
              <div className="conv-assistant__body">
                {streamTail
                  ? <SafeMarkdown content={streamTail} locale="zh" />
                  : <span style={{ color: 'var(--conversation-muted)', fontSize: 13 }}>正在检索与研究……</span>}
                <span className="conv-caret" aria-hidden>▌</span>
              </div>
            </div>
          )}
        </div>
        <footer className="topic-workspace__input">
          <textarea
            rows={2}
            value={input}
            placeholder={session ? '继续讨论:例如「A 和 C 哪个更好?」「我没有企业数据」「就这个。」' : '先在左侧创建选题会话。'}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }}
            disabled={!session || streaming}
            data-testid="topic-input"
          />
          <button type="button" className="btn-primary btn-sm" disabled={!session || streaming || !input.trim()} onClick={() => void send()} data-testid="topic-send">发送</button>
        </footer>
      </section>

      <aside className={`topic-workspace__candidates${rightCollapsed ? ' collapsed' : ''}`} aria-label="候选选题池">
        <header>
          <strong>候选选题({candidates.length})</strong>
          <button type="button" className="btn-secondary btn-sm" onClick={() => setRightCollapsed((value) => !value)} aria-label={rightCollapsed ? '展开候选池' : '折叠候选池'}>
            <ChevronRight size={13} className={rightCollapsed ? undefined : 'rotated'} />
          </button>
        </header>
        {!rightCollapsed && (
          <>
            <ul className="topic-workspace__candidate-list">
              {candidates.map((candidate) => (
                <li key={candidate.id} className={candidate.id === activeCandidateId ? 'active' : undefined}>
                  <button type="button" onClick={() => setActiveCandidateId(candidate.id)} data-testid={`topic-candidate-${candidate.id}`}>
                    <strong>{candidate.title}</strong>
                    <small>{CANDIDATE_STATUS_LABELS[candidate.status] ?? candidate.status}{candidate.noveltyAnalysis ? ` · ${candidate.noveltyAnalysis.slice(0, 40)}` : ''}</small>
                  </button>
                </li>
              ))}
              {candidates.length === 0 && <li className="topic-workspace__empty">检索完成后,候选选题会出现在这里。</li>}
            </ul>
            {activeCandidate && (
              <div className="topic-workspace__candidate-detail" data-testid="topic-candidate-detail">
                <h3>{activeCandidate.title}</h3>
                {activeCandidate.researchQuestion && <p><strong>研究问题:</strong>{activeCandidate.researchQuestion}</p>}
                {activeCandidate.summary && <p>{activeCandidate.summary}</p>}
                {activeCandidate.rationale && <p><strong>选题理由:</strong>{activeCandidate.rationale}</p>}
                {activeCandidate.existingResearch && <p><strong>已有研究:</strong>{activeCandidate.existingResearch}</p>}
                {activeCandidate.researchGap && <p><strong>研究空间:</strong>{activeCandidate.researchGap}</p>}
                {activeCandidate.theoreticalAngles.length > 0 && <p><strong>理论切口:</strong>{activeCandidate.theoreticalAngles.join(';')}</p>}
                {activeCandidate.methodOptions.length > 0 && <p><strong>方法选项:</strong>{activeCandidate.methodOptions.join(';')}</p>}
                {activeCandidate.dataOptions.length > 0 && <p><strong>数据选项:</strong>{activeCandidate.dataOptions.join(';')}</p>}
                {activeCandidate.noveltyAnalysis && <p><strong>创新空间:</strong>{activeCandidate.noveltyAnalysis}</p>}
                {activeCandidate.feasibilityAnalysis && <p><strong>可行性:</strong>{activeCandidate.feasibilityAnalysis}</p>}
                {activeCandidate.risks.length > 0 && <p><strong>风险:</strong>{activeCandidate.risks.join(';')}</p>}
                <EvidenceList refs={activeCandidate.evidenceRefs} />
                <div className="topic-workspace__candidate-actions">
                  {activeCandidate.status === 'candidate' && (
                    <>
                      <button type="button" className="btn-secondary btn-sm" onClick={() => void updateCandidateStatus(activeCandidate.id, 'shortlisted')}>收藏</button>
                      <button type="button" className="btn-secondary btn-sm" onClick={() => void updateCandidateStatus(activeCandidate.id, 'rejected')}>排除</button>
                      <button type="button" className="btn-primary btn-sm" onClick={() => void confirmSelection(activeCandidate)} data-testid="topic-confirm-candidate">确定这个选题</button>
                    </>
                  )}
                  {activeCandidate.status === 'shortlisted' && (
                    <>
                      <button type="button" className="btn-secondary btn-sm" onClick={() => void updateCandidateStatus(activeCandidate.id, 'candidate')}>取消收藏</button>
                      <button type="button" className="btn-primary btn-sm" onClick={() => void confirmSelection(activeCandidate)}>确定这个选题</button>
                    </>
                  )}
                  {activeCandidate.status === 'rejected' && (
                    <button type="button" className="btn-secondary btn-sm" onClick={() => void updateCandidateStatus(activeCandidate.id, 'candidate')}>恢复候选</button>
                  )}
                  {activeCandidate.status === 'selected' && <span className="topic-workspace__selected-tag">已选定</span>}
                </div>
              </div>
            )}
          </>
        )}
      </aside>
    </div>
  );

  if (!chatbotOpen) return workspaceNode;

  return (
    <div className="topic-collab" data-testid="topic-collab" ref={collabWrapRef}>
      {workspaceNode}
      <SplitHandle
        label="拖动调整 Chatbot 面板宽度（40%–45%）"
        testId="chatbot-split-handle"
        onDragStart={() => { void window.metis?.collabHide?.(); }}
        onDrag={(clientX) => applySplitFromClientX(clientX)}
        onDragEnd={() => syncChatbotBounds()}
        onKeyDelta={(delta) => {
          const rect = collabWrapRef.current?.getBoundingClientRect();
          const width = rect && rect.width > 0 ? rect.width : 1;
          setChatbotSplit((ratio) => Math.min(0.45, Math.max(0.4, ratio + delta / width)));
        }}
      />
      <ChatbotCollabPanel
        zh
        buildContextPackage={buildPackage}
        projectId={session?.sourceProjectId ?? null}
        sessionId={activeSessionId}
        splitRatio={chatbotSplit}
        onSplitRatioChange={setChatbotSplit}
        onReferenceConfirmed={handleReferenceConfirmed}
        onClose={() => setChatbotOpen(false)}
      />
    </div>
  );
}
