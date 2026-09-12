/**
 * OnboardingOverlay — 新手引导（刘总 2026-09）。
 *
 * 全屏简约科技风：打招呼并介绍 METIS → 配置并实测模型连接（真实 probe/save/
 * switch，同一套 ProviderProfile 契约）→ 填写个人情况并写入全局 METIS.md
 * （真实 personalization rules 落盘）→ 完成。任何一步都可以跳过；跳过同样
 * 持久化，不再重复打扰。触发条件：尚无任何模型连接档案且本机未完成过引导。
 */
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MetisRulesDefinition, PersonalizationDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { useTranslation } from '../i18n';

const DISMISS_KEY = 'metis:onboarding-done-v1';

function isGlobalRules(definition: PersonalizationDefinition): definition is MetisRulesDefinition {
  return definition.kind === 'rules'
    && (definition as MetisRulesDefinition).scope === 'global'
    && typeof (definition as MetisRulesDefinition).markdown === 'string';
}

function operationId(action: string): string {
  return `onboarding-${action}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

type Step = 0 | 1 | 2 | 3;

export default function OnboardingOverlay() {
  const { locale } = useTranslation();
  const zh = locale === 'zh';
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>(0);
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [model, setModel] = useState('gpt-4o-mini');
  const [apiKey, setApiKey] = useState('');
  const [probeState, setProbeState] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<'idle' | 'probing' | 'saving' | 'metis'>('idle');
  const [profileReady, setProfileReady] = useState(false);
  const [profileNote, setProfileNote] = useState('');
  const [background, setBackground] = useState('');
  const [metisNote, setMetisNote] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (window.localStorage.getItem(DISMISS_KEY) === '1') return;
        const response = await window.metis?.providerProfilesList?.({ contractVersion: 1, operationId: operationId('list') });
        if (cancelled) return;
        // 已有可用模型连接的用户不需要引导；首次使用（无任何档案）才弹出。
        if (response?.ok && response.profiles.length > 0) {
          window.localStorage.setItem(DISMISS_KEY, '1');
          return;
        }
        setOpen(true);
      } catch { /* 桥不可用时静默跳过，不打扰 */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const dismiss = useCallback(() => {
    try { window.localStorage.setItem(DISMISS_KEY, '1'); } catch { /* best-effort */ }
    setOpen(false);
  }, []);

  const probe = useCallback(async () => {
    const metis = window.metis;
    if (!metis?.setupProbe || !apiKey.trim()) {
      setProbeState({ ok: false, text: zh ? '请先填写 API Key。' : 'Enter the API key first.' });
      return;
    }
    setBusy('probing');
    setProbeState(null);
    try {
      const result = await metis.setupProbe({
        version: 1,
        operationId: operationId('probe'),
        keyMode: 'replace',
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        newApiKey: apiKey.trim(),
      });
      // probe 响应统一契约：ok 表达连通性；失败带 code。
      if ((result as { ok?: boolean }).ok) {
        setProbeState({ ok: true, text: zh ? '连接成功。' : 'Connection OK.' });
      } else {
        setProbeState({ ok: false, text: `${zh ? '连接失败' : 'Probe failed'}: ${(result as { code?: string }).code ?? 'unknown'}` });
      }
    } catch {
      setProbeState({ ok: false, text: zh ? '探测服务不可用。' : 'Probe service unavailable.' });
    } finally {
      setBusy('idle');
    }
  }, [apiKey, baseUrl, model, zh]);

  const saveProfile = useCallback(async () => {
    const metis = window.metis;
    if (!metis?.providerProfilesSave || !metis.providerProfilesSwitch) return false;
    setBusy('saving');
    setProfileNote('');
    try {
      const list = await metis.providerProfilesList({ contractVersion: 1, operationId: operationId('list') });
      const revision = list?.ok ? list.revision : 0;
      const saved = await metis.providerProfilesSave({
        contractVersion: 1,
        operationId: operationId('save'),
        expectedRevision: revision,
        name: zh ? '默认连接' : 'Default connection',
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        vision: false,
        maxContextTokens: 0,
        keyMode: 'replace',
        newApiKey: apiKey.trim(),
      });
      if (!saved.ok) {
        setProfileNote(`${zh ? '保存未完成' : 'Save failed'}: ${saved.code ?? 'unknown'}`);
        return false;
      }
      if (!saved.profile) {
        setProfileNote(zh ? '保存未完成：服务未返回连接档案。' : 'Save failed: no profile returned.');
        return false;
      }
      const switched = await metis.providerProfilesSwitch({
        contractVersion: 1,
        operationId: operationId('switch'),
        expectedRevision: saved.revision,
        id: saved.profile.id,
      });
      if (!switched.ok) {
        setProfileNote(`${zh ? '已保存但未激活' : 'Saved but not activated'}: ${switched.code ?? 'unknown'}`);
        return false;
      }
      setProfileReady(true);
      setProfileNote(zh ? '已保存并激活。' : 'Saved and activated.');
      return true;
    } catch {
      setProfileNote(zh ? '模型连接服务不可用。' : 'Model connection service unavailable.');
      return false;
    } finally {
      setBusy('idle');
    }
  }, [apiKey, baseUrl, model, zh]);

  const saveBackground = useCallback(async () => {
    const metis = window.metis;
    const text = background.trim();
    if (!metis?.savePersonalization || !text) return false;
    setBusy('metis');
    setMetisNote('');
    try {
      const response = await metis.listPersonalization?.({ contractVersion: 1, kind: 'rules', includeDisabled: true });
      const existing = (response?.definitions ?? []).find(isGlobalRules) ?? null;
      const section = `\n\n## 研究者背景（引导流程写入）\n\n${text}`;
      const now = Date.now();
      if (existing) {
        const result = await metis.savePersonalization({
          contractVersion: 1,
          definition: {
            ...existing,
            markdown: `${existing.markdown.trimEnd()}${section}`,
            revision: existing.revision + 1,
            provenance: { ...existing.provenance, locallyModified: true, updatedAt: now },
          },
          expectedRevision: existing.revision,
        });
        setMetisNote(result.ok ? (zh ? '已写入全局 METIS.md。' : 'Written to the global METIS.md.') : `${zh ? '写入未完成' : 'Write failed'}: ${result.code ?? 'unknown'}`);
        return result.ok;
      }
      const created: MetisRulesDefinition = {
        contractVersion: 1,
        id: `user:rules/global-metis-${now.toString(36)}`,
        kind: 'rules',
        name: zh ? '全局 METIS.md' : 'Global METIS.md',
        description: zh ? '全局研究行为规则（含研究者背景）。' : 'Global research behavior rules (with researcher background).',
        enabled: true,
        tags: [],
        revision: 1,
        scope: 'global',
        scopeId: null,
        markdown: `# METIS.md\n${section}`,
        provenance: {
          origin: 'user',
          author: zh ? '刘总' : 'local user',
          version: '1.0.0',
          license: null,
          sourceUrl: null,
          sourceRevision: null,
          installedDigest: null,
          parentId: null,
          parentVersion: null,
          locallyModified: true,
          createdAt: now,
          updatedAt: now,
        },
      };
      const result = await metis.savePersonalization({ contractVersion: 1, definition: created, expectedRevision: 0 });
      setMetisNote(result.ok ? (zh ? '已创建全局 METIS.md。' : 'Global METIS.md created.') : `${zh ? '创建未完成' : 'Creation failed'}: ${result.code ?? 'unknown'}`);
      return result.ok;
    } catch {
      setMetisNote(zh ? '个性化服务不可用。' : 'Personalization service unavailable.');
      return false;
    } finally {
      setBusy('idle');
    }
  }, [background, zh]);

  if (!open) return null;

  return createPortal(
    <div className="onboarding-overlay" role="dialog" aria-modal="true" aria-label={zh ? 'METIS 新手引导' : 'METIS onboarding'} data-testid="onboarding-overlay">
      <section className="onboarding-card">
        <div className="onboarding-card__glow" aria-hidden />
        {step === 0 && (
          <>
            <h1>{zh ? '你好，我是 METIS' : 'Hi, I am METIS'}</h1>
            <p className="onboarding-card__lead">{zh
              ? '一个为社会科学研究打造的 AI 工作台：选题、文献、研究设计、数据分析、写作、投稿，每一步都有真实工具在为你工作。'
              : 'An AI workbench for social science research: topics, literature, design, analysis, writing, and submission — with real tools working for you at every step.'}</p>
            <ul className="onboarding-card__points">
              <li>{zh ? '对话即研究：发消息就能建任务、跑工作流、产出文件' : 'Chat is research: send a message to start tasks, workflows, and deliverables'}</li>
              <li>{zh ? '过程透明：每一步工具调用与思考过程可见、可中断' : 'Transparent: every tool call is visible and interruptible'}</li>
              <li>{zh ? '记忆与你相关：全局/项目/场景三层 METIS.md 规则' : 'Yours: three layers of METIS.md memory rules'}</li>
            </ul>
            <div className="onboarding-card__actions">
              <button type="button" className="btn-secondary" onClick={dismiss} data-testid="onboarding-skip">{zh ? '跳过' : 'Skip'}</button>
              <button type="button" className="btn-primary" onClick={() => setStep(1)} data-testid="onboarding-next">{zh ? '开始配置' : 'Get started'}</button>
            </div>
          </>
        )}
        {step === 1 && (
          <>
            <h1>{zh ? '连接你的模型' : 'Connect your model'}</h1>
            <p className="onboarding-card__lead">{zh ? '填写任意 OpenAI 兼容服务的地址、模型名与 API Key。连接信息只保存在本机加密存储。' : 'Any OpenAI-compatible endpoint works. Credentials stay in local encrypted storage.'}</p>
            <div className="onboarding-form">
              <label>Base URL<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} data-testid="onboarding-base-url" spellCheck={false} /></label>
              <label>{zh ? '模型名' : 'Model'}<input value={model} onChange={(event) => setModel(event.target.value)} data-testid="onboarding-model" spellCheck={false} /></label>
              <label>API Key<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} data-testid="onboarding-api-key" autoComplete="off" /></label>
              <div className="onboarding-form__row">
                <button type="button" className="btn-secondary btn-sm" disabled={busy !== 'idle' || !apiKey.trim()} onClick={() => void probe()} data-testid="onboarding-probe">{busy === 'probing' ? (zh ? '测试中…' : 'Testing…') : (zh ? '测试连接' : 'Test connection')}</button>
                {probeState && <span role="status" className={probeState.ok ? 'is-ok' : 'is-err'}>{probeState.text}</span>}
              </div>
              {profileNote && <span role="status" className={profileReady ? 'is-ok' : 'is-err'}>{profileNote}</span>}
            </div>
            <div className="onboarding-card__actions">
              <button type="button" className="btn-secondary" onClick={dismiss}>{zh ? '跳过' : 'Skip'}</button>
              <button type="button" className="btn-secondary" onClick={() => setStep(0)}>{zh ? '上一步' : 'Back'}</button>
              <button type="button" className="btn-primary" disabled={busy !== 'idle'} onClick={() => { void (async () => { if (await saveProfile()) setStep(2); })(); }} data-testid="onboarding-save-profile">{busy === 'saving' ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存并继续' : 'Save & continue')}</button>
            </div>
          </>
        )}
        {step === 2 && (
          <>
            <h1>{zh ? '让 METIS 了解你' : 'Tell METIS about you'}</h1>
            <p className="onboarding-card__lead">{zh ? '用几句话描述你的学科、研究方向与写作习惯。这段内容会真实写入全局 METIS.md，之后每次对话都会遵守。' : 'Describe your discipline, research focus, and writing habits. This is written into the global METIS.md and honored in every conversation.'}</p>
            <textarea
              className="onboarding-textarea"
              value={background}
              onChange={(event) => setBackground(event.target.value)}
              rows={6}
              placeholder={zh ? '例如：我是社会学博士生，目前做平台劳动的实证研究，常用调查数据与回归分析，写作偏学术中性。' : 'e.g. PhD student in sociology; empirical research on platform labor; survey data and regression; neutral academic style.'}
              data-testid="onboarding-background"
            />
            {metisNote && <span role="status" className={metisNote.includes('已') ? 'is-ok' : 'is-err'}>{metisNote}</span>}
            <div className="onboarding-card__actions">
              <button type="button" className="btn-secondary" onClick={dismiss}>{zh ? '跳过' : 'Skip'}</button>
              <button type="button" className="btn-secondary" onClick={() => setStep(1)}>{zh ? '上一步' : 'Back'}</button>
              <button type="button" className="btn-primary" disabled={busy === 'metis' || !background.trim()} onClick={() => { void (async () => { if (await saveBackground()) setStep(3); })(); }} data-testid="onboarding-save-metis">{busy === 'metis' ? (zh ? '写入中…' : 'Writing…') : (zh ? '生成全局 METIS.md' : 'Generate global METIS.md')}</button>
            </div>
          </>
        )}
        {step === 3 && (
          <>
            <h1>{zh ? '一切就绪' : 'All set'}</h1>
            <p className="onboarding-card__lead">{zh ? '模型已连接，你的研究背景已写入全局规则。随时可以在「设置」里修改全局 METIS.md 与模型连接。' : 'Model connected and your background is stored in the global rules. You can edit both anytime in Settings.'}</p>
            <div className="onboarding-card__actions">
              <button type="button" className="btn-primary" onClick={dismiss} data-testid="onboarding-finish">{zh ? '开始研究' : 'Start researching'}</button>
            </div>
          </>
        )}
      </section>
    </div>,
    document.body,
  );
}
