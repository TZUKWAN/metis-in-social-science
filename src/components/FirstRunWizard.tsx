import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useTranslation, type LocaleKey } from '../i18n';
import {
  SETUP_DEFAULT_INPUT,
  SETUP_RUNTIME_CONTRACT_VERSION,
  createSetupRecovery,
  decodeSetupProgressEvent,
  decodeSetupProbeResponse,
  decodeSetupSaveResponse,
  inspectSetupInput,
  type SetupAbortRequest,
  type SetupCapabilityWarning,
  type SetupErrorCode,
  type SetupInput,
  type SetupInputField,
  type SetupInputFieldErrorCode,
  type SetupProgressEvent,
  type SetupProgressPhase,
  type SetupRecovery,
  type SetupRecoveryAction,
  type SetupSaveRequest,
  type SetupSaveSuccess,
  type SetupStage,
} from '../../engine/runtime/SetupRuntimeContract';
import './FirstRunWizard.css';

export interface FirstRunSetupClient {
  probe(
    request: { version: 1; operationId: string; keyMode: 'saved' | 'replace'; baseUrl: string; model: string; newApiKey?: string },
    onProgress?: (event: unknown) => void,
  ): Promise<unknown>;
  save(
    request: SetupSaveRequest,
    onProgress?: (event: unknown) => void,
  ): Promise<unknown>;
  abort(request: SetupAbortRequest): Promise<unknown> | unknown;
}

export interface FirstRunWizardProps {
  client: FirstRunSetupClient;
  onComplete: (result: SetupSaveSuccess) => void;
  /** Optional exit: enter the app without configuring a provider (local mode). */
  onSkip?: () => void;
  initialConfig?: Partial<Pick<SetupInput, 'baseUrl' | 'model'>>;
}

interface WizardCopy {
  eyebrow: string;
  title: string;
  intro: string;
  privacy: string;
  baseUrlLabel: string;
  baseUrlHint: string;
  apiKeyLabel: string;
  apiKeyHint: string;
  modelLabel: string;
  modelHint: string;
  showKey: string;
  hideKey: string;
  submit: string;
  working: string;
  completed: string;
  stop: string;
  skip: string;
  progressTitle: string;
  progressHint: string;
  readyTitle: string;
  connectionReady: string;
  toolsReady: string;
  toolsCompatible: string;
  streamingReady: string;
  streamingStandard: string;
  contextKnown: (tokens: number) => string;
  contextUnknown: string;
  errorImpact: string;
  errorHandled: string;
  errorNext: string;
  retry: string;
  edit: string;
  escapeHint: string;
}

const COPY: Record<LocaleKey, WizardCopy> = {
  zh: {
    eyebrow: '首次设置',
    title: '连接你的模型服务',
    intro: '只需填写下面三项。Metis 会自动检查模型能力，并选择合适的研究执行方式。',
    privacy: 'API 密钥只会通过系统安全存储加密保存，不会以明文写入配置文件。',
    baseUrlLabel: 'API 地址',
    baseUrlHint: '请输入服务商提供的接口地址。Metis 支持常见的 OpenAI 接口格式；远程服务须使用 HTTPS。',
    apiKeyLabel: 'API 密钥',
    apiKeyHint: '密钥至少 8 个字符。Metis 不会在错误信息或界面状态中回显密钥。',
    modelLabel: '模型名称',
    modelHint: '填写服务商提供的准确模型名称，例如 gpt-4o-mini 或 glm-4.7-flash。',
    showKey: '显示密钥',
    hideKey: '隐藏密钥',
    submit: '连接并开始使用',
    working: '正在设置…',
    completed: '设置完成',
    stop: '停止',
    skip: '稍后配置',
    progressTitle: '正在完成连接',
    progressHint: '通常只需片刻。你可以按 Esc 停止本次尝试。',
    readyTitle: '模型能力已确认',
    connectionReady: '模型服务可以连接',
    toolsReady: '可自动使用研究工具',
    toolsCompatible: '将用兼容方式完成工具步骤',
    streamingReady: '回答可以边生成边显示',
    streamingStandard: '回答将在生成完成后显示',
    contextKnown: (tokens) => `已识别可处理长度：约 ${tokens.toLocaleString()} 个文本单位`,
    contextUnknown: '服务未提供可处理长度，Metis 将采用保守设置',
    errorImpact: '影响',
    errorHandled: 'Metis 已处理',
    errorNext: '下一步',
    retry: '重新尝试',
    edit: '修改填写内容',
    escapeHint: '按 Esc 可停止',
  },
  en: {
    eyebrow: 'First-time setup',
    title: 'Connect your model service',
    intro: 'Enter only these three details. Metis will check the model and choose a suitable research strategy automatically.',
    privacy: 'Your API key is encrypted with the operating system secure store and is never written to the configuration file in plain text.',
    baseUrlLabel: 'API address',
    baseUrlHint: 'Enter the API address supplied by your provider. Common OpenAI-compatible services are supported; remote services must use HTTPS.',
    apiKeyLabel: 'API key',
    apiKeyHint: 'The key must contain at least 8 characters. Metis never echoes it in errors or status messages.',
    modelLabel: 'Model name',
    modelHint: 'Use the exact model name from your provider, such as gpt-4o-mini or glm-4.7-flash.',
    showKey: 'Show key',
    hideKey: 'Hide key',
    submit: 'Connect and continue',
    working: 'Setting up…',
    completed: 'Setup complete',
    stop: 'Stop',
    skip: 'Configure later',
    progressTitle: 'Completing the connection',
    progressHint: 'This usually takes a moment. Press Escape to stop this attempt.',
    readyTitle: 'Model capabilities confirmed',
    connectionReady: 'The model service is reachable',
    toolsReady: 'Research tools can run automatically',
    toolsCompatible: 'Tool steps will use a compatible fallback',
    streamingReady: 'Answers can appear while they are generated',
    streamingStandard: 'Answers will appear after generation finishes',
    contextKnown: (tokens) => `Recognized working length: about ${tokens.toLocaleString()} text units`,
    contextUnknown: 'The service did not report a working length, so Metis will use conservative settings',
    errorImpact: 'Impact',
    errorHandled: 'What Metis did',
    errorNext: 'Next step',
    retry: 'Try again',
    edit: 'Edit details',
    escapeHint: 'Press Escape to stop',
  },
};

const PHASE_ORDER: Record<SetupProgressPhase, number> = {
  validating_input: 0,
  checking_connection: 1,
  checking_tool_use: 2,
  checking_structured_output: 2,
  checking_streaming: 2,
  checking_model_details: 2,
  preparing_runtime: 3,
  protecting_api_key: 4,
  saving_configuration: 4,
  activating_runtime: 5,
  complete: 6,
};

const PROGRESS_STEPS: Record<LocaleKey, readonly string[]> = {
  zh: [
    '检查填写内容',
    '连接模型服务',
    '了解模型能力',
    '准备研究环境',
    '安全保存配置',
    '启用新配置',
  ],
  en: [
    'Check the details',
    'Connect to the model service',
    'Learn the model capabilities',
    'Prepare the research environment',
    'Protect and save the configuration',
    'Activate the new configuration',
  ],
};

const FIELD_ERRORS: Record<SetupInputFieldErrorCode, Record<LocaleKey, string>> = {
  setup_api_url_invalid: {
    zh: '请输入有效地址。远程地址使用 HTTPS，本机地址可使用 http://localhost。',
    en: 'Enter a valid address. Use HTTPS remotely; http://localhost is allowed locally.',
  },
  setup_api_key_invalid: {
    zh: '请输入至少 8 个字符且不含空格的 API 密钥。',
    en: 'Enter an API key with at least 8 characters and no spaces.',
  },
  setup_model_invalid: {
    zh: '请输入服务商提供的模型名称，不要包含空格。',
    en: 'Enter the model name supplied by your provider, without spaces.',
  },
};

const ERROR_TITLES: Record<SetupErrorCode, Record<LocaleKey, string>> = {
  setup_request_unavailable: { zh: '本次设置请求无效', en: 'This setup request is invalid' },
  setup_input_invalid: { zh: '请检查填写内容', en: 'Check the details you entered' },
  setup_api_url_invalid: { zh: 'API 地址不可用', en: 'The API address is not valid' },
  setup_api_key_invalid: { zh: 'API 密钥格式不正确', en: 'The API key format is not valid' },
  setup_model_invalid: { zh: '模型名称格式不正确', en: 'The model name format is not valid' },
  setup_secure_storage_unavailable: { zh: '系统安全存储暂不可用', en: 'System secure storage is unavailable' },
  setup_probe_unauthorized: { zh: 'API 密钥未通过验证', en: 'The API key was not accepted' },
  setup_probe_forbidden: { zh: '此密钥没有访问权限', en: 'This key does not have access' },
  setup_probe_model_not_found: { zh: '没有找到这个模型', en: 'The model was not found' },
  setup_probe_rate_limited: { zh: '服务暂时限制了请求', en: 'The service is temporarily limiting requests' },
  setup_probe_timeout: { zh: '连接等待时间过长', en: 'The connection took too long' },
  setup_probe_tls_failed: { zh: '无法确认服务连接安全', en: 'The secure connection could not be verified' },
  setup_probe_network_unavailable: { zh: '无法连接到模型服务', en: 'Metis could not reach the model service' },
  setup_probe_server_unavailable: { zh: '模型服务暂时不可用', en: 'The model service is temporarily unavailable' },
  setup_probe_response_unavailable: { zh: '模型服务返回了无法识别的结果', en: 'The model service returned an unrecognized result' },
  setup_probe_expired: { zh: '连接检查已经过期', en: 'The connection check has expired' },
  setup_save_conflict: { zh: '配置已在其他操作中更新', en: 'The configuration changed in another operation' },
  setup_save_failed: { zh: '配置没有保存成功', en: 'The configuration could not be saved' },
  setup_save_rollback_failed: { zh: '配置恢复未能完整完成', en: 'The previous configuration could not be fully restored' },
  setup_config_invalid: { zh: '已保存的配置无法读取', en: 'The saved configuration is not valid' },
  setup_config_decrypt_failed: { zh: '无法解锁已保存的 API 密钥', en: 'The saved API key could not be unlocked' },
  setup_restore_failed: { zh: '无法恢复上次的设置', en: 'The previous setup could not be restored' },
  setup_runtime_rebuild_failed: { zh: '研究环境未能启动', en: 'The research environment could not start' },
  setup_operation_aborted: { zh: '本次设置已停止', en: 'This setup attempt was stopped' },
};

const STAGE_IMPACT: Record<SetupStage, Record<LocaleKey, string>> = {
  input: {
    zh: '尚未连接模型服务，也没有保存任何新配置。',
    en: 'No model connection was made and no new configuration was saved.',
  },
  probe: {
    zh: '模型能力尚未确认，研究功能暂未启用。',
    en: 'Model capabilities are not confirmed, so research features are not enabled yet.',
  },
  save: {
    zh: '新配置尚未成为当前配置。',
    en: 'The new configuration has not become the active configuration.',
  },
  restore: {
    zh: '上次保存的模型连接尚未恢复。',
    en: 'The previously saved model connection has not been restored.',
  },
  runtime: {
    zh: '模型连接可能已验证，但新的研究环境尚未启用。',
    en: 'The model connection may be valid, but the new research environment is not active.',
  },
};

const STAGE_HANDLED: Record<SetupStage, Record<LocaleKey, string>> = {
  input: {
    zh: '已阻止无效内容继续提交。',
    en: 'Metis prevented invalid details from being submitted.',
  },
  probe: {
    zh: '已停止后续探测，且没有保存 API 密钥。',
    en: 'Metis stopped further checks and did not save the API key.',
  },
  save: {
    zh: '已保留原有配置；未验证的新配置不会覆盖它。',
    en: 'Metis kept the previous configuration and did not replace it with an unverified one.',
  },
  restore: {
    zh: '已停止加载，避免使用损坏或无法解密的配置。',
    en: 'Metis stopped loading to avoid using damaged or unreadable configuration data.',
  },
  runtime: {
    zh: '已放弃未成功启动的候选环境，并阻止旧请求混入新配置。',
    en: 'Metis discarded the failed candidate environment and blocked old requests from entering the new configuration.',
  },
};

const ACTION_NEXT: Record<SetupRecoveryAction, Record<LocaleKey, string>> = {
  edit_api_url: {
    zh: '核对服务商给出的 API 地址和 HTTPS 证书后再试。',
    en: 'Check the provider API address and HTTPS certificate, then try again.',
  },
  edit_api_key: {
    zh: '重新输入有效密钥，并确认该密钥有权使用所选模型。',
    en: 'Enter a valid key and confirm it can access the selected model.',
  },
  edit_model: {
    zh: '从服务商控制台复制准确的模型名称后再试。',
    en: 'Copy the exact model name from the provider console and try again.',
  },
  retry: {
    zh: '检查网络和填写内容，然后重新尝试。',
    en: 'Check the network and your details, then try again.',
  },
  wait_and_retry: {
    zh: '稍等片刻后重试；如持续发生，请检查服务状态或账户额度。',
    en: 'Wait briefly and try again. If it continues, check service status or account limits.',
  },
  restart_app: {
    zh: '关闭并重新打开 Metis；系统安全存储恢复后再继续。',
    en: 'Close and reopen Metis, then continue after system secure storage is available.',
  },
  contact_support: {
    zh: '保留当前数据并联系支持人员检查配置文件；不要手工复制或粘贴 API 密钥。',
    en: 'Keep the current data and ask support to inspect the configuration file. Do not copy or paste the API key manually.',
  },
};

const WARNING_COPY: Record<SetupCapabilityWarning, Record<LocaleKey, string>> = {
  setup_native_tools_unavailable: {
    zh: '此模型不直接支持研究工具调用，Metis 将使用兼容方式并增加结果检查。',
    en: 'This model does not call research tools directly. Metis will use a compatible method with extra result checks.',
  },
  setup_streaming_unavailable: {
    zh: '此服务不支持边生成边显示，回答会在完成后一次显示。',
    en: 'This service cannot show an answer while it is generated; the answer will appear when complete.',
  },
  setup_structured_output_unavailable: {
    zh: '此模型不直接提供结构化回答，Metis 将增加格式检查。',
    en: 'This model does not provide structured answers directly, so Metis will add format checks.',
  },
  setup_context_length_unknown: {
    zh: '服务未报告可处理长度，Metis 将采用较保守的研究步骤。',
    en: 'The service did not report a working length, so Metis will use more conservative research steps.',
  },
};

let operationSequence = 0;

function nextOperationId(): string {
  operationSequence += 1;
  return `setup-${Date.now().toString(36)}-${operationSequence.toString(36)}`;
}

function firstFieldWithError(
  errors: Partial<Record<SetupInputField, SetupInputFieldErrorCode>>,
): SetupInputField | undefined {
  if (errors.baseUrl) return 'baseUrl';
  if (errors.apiKey) return 'apiKey';
  if (errors.model) return 'model';
  return undefined;
}

function phaseStatus(
  stepIndex: number,
  phase: SetupProgressPhase,
): 'pending' | 'current' | 'complete' {
  const currentIndex = PHASE_ORDER[phase];
  if (phase === 'complete' || stepIndex < currentIndex) return 'complete';
  if (stepIndex === currentIndex) return 'current';
  return 'pending';
}

function retryLabel(recovery: SetupRecovery, copy: WizardCopy): string {
  return recovery.action === 'edit_api_url'
    || recovery.action === 'edit_api_key'
    || recovery.action === 'edit_model'
    ? copy.edit
    : copy.retry;
}

function safeAbort(client: FirstRunSetupClient, operationId: string): void {
  try {
    Promise.resolve(client.abort({
      version: SETUP_RUNTIME_CONTRACT_VERSION,
      operationId,
    })).catch(() => undefined);
  } catch {
    // The renderer still invalidates the run token, so stale responses are ignored.
  }
}

export default function FirstRunWizard({
  client,
  onComplete,
  onSkip,
  initialConfig,
}: FirstRunWizardProps) {
  const { locale } = useTranslation();
  const copy = COPY[locale];
  const id = useId().replace(/:/gu, '');
  const baseUrlId = `setup-base-url-${id}`;
  const apiKeyId = `setup-api-key-${id}`;
  const modelId = `setup-model-${id}`;
  const [form, setForm] = useState<SetupInput>({
    baseUrl: initialConfig?.baseUrl ?? SETUP_DEFAULT_INPUT.baseUrl,
    apiKey: '',
    model: initialConfig?.model ?? SETUP_DEFAULT_INPUT.model,
  });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<SetupInputField, SetupInputFieldErrorCode>>>({});
  const [recovery, setRecovery] = useState<SetupRecovery | null>(null);
  const [progress, setProgress] = useState<SetupProgressEvent | null>(null);
  const [probeSummary, setProbeSummary] = useState<SetupSaveSuccess | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState(false);
  const activeOperationRef = useRef<string | null>(null);
  const activeStageRef = useRef<'probe' | 'save'>('probe');
  const runTokenRef = useRef(0);
  const mountedRef = useRef(true);
  const formRef = useRef<HTMLFormElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const baseUrlRef = useRef<HTMLInputElement>(null);
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const modelRef = useRef<HTMLInputElement>(null);
  const activePhase = progress?.phase ?? 'validating_input';
  const canStop = busy && activePhase !== 'activating_runtime';
  const progressSteps = PROGRESS_STEPS[locale];
  const progressLabel = progressSteps[
    Math.min(PHASE_ORDER[activePhase], progressSteps.length - 1)
  ] ?? copy.progressTitle;

  useEffect(() => {
    mountedRef.current = true;
    baseUrlRef.current?.focus();
    return () => {
      mountedRef.current = false;
      const operationId = activeOperationRef.current;
      if (operationId) safeAbort(client, operationId);
    };
  }, [client]);

  useEffect(() => {
    if (recovery) errorRef.current?.focus();
  }, [recovery]);

  const updateField = (field: SetupInputField, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
    setRecovery(null);
    setProbeSummary(null);
    setProgress(null);
    setCompleted(false);
  };

  const applyProgress = (operationId: string, event: unknown) => {
    const decoded = decodeSetupProgressEvent(event);
    if (
      decoded
      && decoded.operationId === operationId
      && activeOperationRef.current === operationId
      && mountedRef.current
    ) {
      setProgress(decoded);
    }
  };

  const focusField = (field: SetupInputField | undefined) => {
    if (field === 'baseUrl') baseUrlRef.current?.focus();
    if (field === 'apiKey') apiKeyRef.current?.focus();
    if (field === 'model') modelRef.current?.focus();
  };

  const stopCurrentAttempt = () => {
    const operationId = activeOperationRef.current;
    if (!operationId) return;
    runTokenRef.current += 1;
    safeAbort(client, operationId);
    activeOperationRef.current = null;
    setBusy(false);
    setProgress(null);
    setRecovery(createSetupRecovery('setup_operation_aborted', { stage: activeStageRef.current }));
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Escape' && canStop) {
      event.preventDefault();
      stopCurrentAttempt();
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || completed) return;

    const inspection = inspectSetupInput({
      baseUrl: form.baseUrl.trim(),
      apiKey: form.apiKey,
      model: form.model.trim(),
    });
    if (!inspection.ok) {
      setFieldErrors(inspection.fieldErrors);
      const firstField = firstFieldWithError(inspection.fieldErrors);
      const code = firstField ? inspection.fieldErrors[firstField] : undefined;
      setRecovery(createSetupRecovery(code ?? 'setup_input_invalid'));
      focusField(firstField);
      return;
    }

    const operationId = nextOperationId();
    const runToken = runTokenRef.current + 1;
    runTokenRef.current = runToken;
    activeOperationRef.current = operationId;
    activeStageRef.current = 'probe';
    setBusy(true);
    setRecovery(null);
    setFieldErrors({});
    setProbeSummary(null);
    setProgress({
      version: SETUP_RUNTIME_CONTRACT_VERSION,
      operationId,
      phase: 'validating_input',
      percent: 0,
    });

    let stage: 'probe' | 'save' = 'probe';
    let completedResult: SetupSaveSuccess | undefined;
    try {
      const probeResult = decodeSetupProbeResponse(await client.probe({
        version: SETUP_RUNTIME_CONTRACT_VERSION,
        operationId,
        keyMode: 'replace',
        baseUrl: inspection.value.baseUrl,
        model: inspection.value.model,
        newApiKey: inspection.value.apiKey,
      }, (progressEvent) => applyProgress(operationId, progressEvent)));
      if (
        !mountedRef.current
        || runTokenRef.current !== runToken
        || activeOperationRef.current !== operationId
      ) return;
      if (!probeResult.success) {
        setProgress(null);
        setRecovery(probeResult.recovery);
        return;
      }

      stage = 'save';
      activeStageRef.current = 'save';
      setProgress({
        version: SETUP_RUNTIME_CONTRACT_VERSION,
        operationId,
        phase: 'preparing_runtime',
        percent: 52,
      });
      const saveResult = decodeSetupSaveResponse(await client.save({
        version: SETUP_RUNTIME_CONTRACT_VERSION,
        operationId,
        expectedConfigVersion: probeResult.configVersion,
        probeId: probeResult.probeId,
      }, (progressEvent) => applyProgress(operationId, progressEvent)));
      if (
        !mountedRef.current
        || runTokenRef.current !== runToken
        || activeOperationRef.current !== operationId
      ) return;
      if (!saveResult.success) {
        setProgress(null);
        setRecovery(saveResult.recovery);
        return;
      }

      setProbeSummary(saveResult);
      setProgress({
        version: SETUP_RUNTIME_CONTRACT_VERSION,
        operationId,
        phase: 'complete',
        percent: 100,
      });
      activeOperationRef.current = null;
      setBusy(false);
      setShowKey(false);
      setForm((current) => ({ ...current, apiKey: '' }));
      setCompleted(true);
      completedResult = saveResult;
    } catch {
      if (
        mountedRef.current
        && runTokenRef.current === runToken
        && activeOperationRef.current === operationId
      ) {
        setProgress(null);
        setRecovery(createSetupRecovery(
          stage === 'probe' ? 'setup_probe_response_unavailable' : 'setup_save_failed',
        ));
      }
    } finally {
      if (
        mountedRef.current
        && runTokenRef.current === runToken
        && activeOperationRef.current === operationId
      ) {
        activeOperationRef.current = null;
        setBusy(false);
      }
    }
    if (completedResult) onComplete(completedResult);
  };

  return (
    <main className="first-run" aria-labelledby={`${id}-title`}>
      <section className="first-run-card">
        <div className="first-run-brand" aria-hidden="true">M</div>
        <p className="first-run-eyebrow">{copy.eyebrow}</p>
        <h1 id={`${id}-title`}>{copy.title}</h1>
        <p className="first-run-intro">{copy.intro}</p>

        <div className="first-run-privacy" role="note">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3l7 3v5c0 4.6-2.8 8.1-7 10-4.2-1.9-7-5.4-7-10V6l7-3z" />
            <path d="M9.5 12l1.7 1.7 3.6-4" />
          </svg>
          <span>{copy.privacy}</span>
        </div>

        <form
          ref={formRef}
          className="first-run-form"
          onSubmit={handleSubmit}
          onKeyDown={handleKeyDown}
          aria-busy={busy}
          noValidate
        >
          <div className="first-run-field">
            <label htmlFor={baseUrlId}>{copy.baseUrlLabel}</label>
            <input
              ref={baseUrlRef}
              id={baseUrlId}
              name="baseUrl"
              type="url"
              inputMode="url"
              autoComplete="url"
              value={form.baseUrl}
              onChange={(event) => updateField('baseUrl', event.target.value)}
              aria-invalid={fieldErrors.baseUrl ? true : undefined}
              aria-describedby={`${baseUrlId}-hint${fieldErrors.baseUrl ? ` ${baseUrlId}-error` : ''}`}
              disabled={busy || completed}
              required
            />
            <p id={`${baseUrlId}-hint`} className="first-run-field-hint">{copy.baseUrlHint}</p>
            {fieldErrors.baseUrl && (
              <p id={`${baseUrlId}-error`} className="first-run-field-error">
                {FIELD_ERRORS[fieldErrors.baseUrl][locale]}
              </p>
            )}
          </div>

          <div className="first-run-field">
            <label htmlFor={apiKeyId}>{copy.apiKeyLabel}</label>
            <div className="first-run-secret-input">
              <input
                ref={apiKeyRef}
                id={apiKeyId}
                name="apiKey"
                type={showKey ? 'text' : 'password'}
                autoComplete="new-password"
                spellCheck={false}
                value={form.apiKey}
                onChange={(event) => updateField('apiKey', event.target.value)}
                aria-invalid={fieldErrors.apiKey ? true : undefined}
                aria-describedby={`${apiKeyId}-hint${fieldErrors.apiKey ? ` ${apiKeyId}-error` : ''}`}
                disabled={busy || completed}
                required
              />
              <button
                type="button"
                className="first-run-secret-toggle"
                onClick={() => setShowKey((visible) => !visible)}
                aria-pressed={showKey}
                aria-controls={apiKeyId}
                disabled={busy || completed}
              >
                {showKey ? copy.hideKey : copy.showKey}
              </button>
            </div>
            <p id={`${apiKeyId}-hint`} className="first-run-field-hint">{copy.apiKeyHint}</p>
            {fieldErrors.apiKey && (
              <p id={`${apiKeyId}-error`} className="first-run-field-error">
                {FIELD_ERRORS[fieldErrors.apiKey][locale]}
              </p>
            )}
          </div>

          <div className="first-run-field">
            <label htmlFor={modelId}>{copy.modelLabel}</label>
            <input
              ref={modelRef}
              id={modelId}
              name="model"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={form.model}
              onChange={(event) => updateField('model', event.target.value)}
              aria-invalid={fieldErrors.model ? true : undefined}
              aria-describedby={`${modelId}-hint${fieldErrors.model ? ` ${modelId}-error` : ''}`}
              disabled={busy || completed}
              required
            />
            <p id={`${modelId}-hint`} className="first-run-field-hint">{copy.modelHint}</p>
            {fieldErrors.model && (
              <p id={`${modelId}-error`} className="first-run-field-error">
                {FIELD_ERRORS[fieldErrors.model][locale]}
              </p>
            )}
          </div>

          {recovery && (
            <div
              ref={errorRef}
              className="first-run-error"
              role="alert"
              tabIndex={-1}
            >
              <div className="first-run-error-heading">
                <span aria-hidden="true">!</span>
                <h2>{ERROR_TITLES[recovery.code][locale]}</h2>
              </div>
              <dl>
                <div>
                  <dt>{copy.errorImpact}</dt>
                  <dd>{STAGE_IMPACT[recovery.stage][locale]}</dd>
                </div>
                <div>
                  <dt>{copy.errorHandled}</dt>
                  <dd>{STAGE_HANDLED[recovery.stage][locale]}</dd>
                </div>
                <div>
                  <dt>{copy.errorNext}</dt>
                  <dd>{ACTION_NEXT[recovery.action][locale]}</dd>
                </div>
              </dl>
              {recovery.retryable && recovery.action !== 'restart_app' && (
                <button
                  type="button"
                  className="first-run-error-action"
                  onClick={() => {
                    setRecovery(null);
                    const editField = recovery.action === 'edit_api_url'
                      ? 'baseUrl'
                      : recovery.action === 'edit_api_key'
                        ? 'apiKey'
                        : recovery.action === 'edit_model'
                          ? 'model'
                          : undefined;
                    if (editField) focusField(editField);
                    else formRef.current?.requestSubmit();
                  }}
                >
                  {retryLabel(recovery, copy)}
                </button>
              )}
            </div>
          )}

          {(busy || progress) && (
            <section className="first-run-progress" aria-labelledby={`${id}-progress-title`}>
              <div className="first-run-progress-heading">
                <div>
                  <h2 id={`${id}-progress-title`}>{copy.progressTitle}</h2>
                  <p>{copy.progressHint}</p>
                </div>
                <strong aria-hidden="true">{progress?.percent ?? 0}%</strong>
              </div>
              <progress
                max={100}
                value={progress?.percent ?? 0}
                aria-label={progressLabel}
              />
              <p className="sr-only" role="status" aria-live="polite">
                {progressLabel}
              </p>
              <ol className="first-run-progress-steps">
                {progressSteps.map((step, index) => {
                  const status = phaseStatus(index, activePhase);
                  return (
                    <li key={step} data-status={status} aria-current={status === 'current' ? 'step' : undefined}>
                      <span aria-hidden="true">{status === 'complete' ? '✓' : index + 1}</span>
                      {step}
                    </li>
                  );
                })}
              </ol>
            </section>
          )}

          {probeSummary && (
            <section className="first-run-capabilities" aria-labelledby={`${id}-capabilities-title`}>
              <h2 id={`${id}-capabilities-title`}>{copy.readyTitle}</h2>
              <ul>
                <li>{copy.connectionReady}</li>
                <li>{probeSummary.capabilities.nativeToolCalling ? copy.toolsReady : copy.toolsCompatible}</li>
                <li>{probeSummary.capabilities.streaming ? copy.streamingReady : copy.streamingStandard}</li>
                <li>
                  {probeSummary.capabilities.maxContextTokens === null
                    ? copy.contextUnknown
                    : copy.contextKnown(probeSummary.capabilities.maxContextTokens)}
                </li>
              </ul>
              {probeSummary.warnings.length > 0 && (
                <div className="first-run-warnings">
                  {probeSummary.warnings.map((warning) => (
                    <p key={warning}>{WARNING_COPY[warning][locale]}</p>
                  ))}
                </div>
              )}
            </section>
          )}

          <div className="first-run-actions">
            {onSkip && !busy && !completed && (
              <button
                type="button"
                className="first-run-skip"
                onClick={onSkip}
                data-testid="first-run-skip"
              >
                {copy.skip}
              </button>
            )}
            {canStop && (
              <button
                type="button"
                className="first-run-stop"
                onClick={stopCurrentAttempt}
                aria-keyshortcuts="Escape"
              >
                {copy.stop}
                <span>{copy.escapeHint}</span>
              </button>
            )}
            <button type="submit" className="first-run-submit" disabled={busy || completed}>
              {completed ? copy.completed : busy ? copy.working : copy.submit}
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
