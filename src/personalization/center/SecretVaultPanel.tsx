import { useState } from 'react';
import { useTranslation } from '../../i18n';
import type { PersonalizationSecretVaultHandle } from '../mcpCredentialVault.js';

export function SecretVaultPanel({ vault }: { vault: PersonalizationSecretVaultHandle }) {
  const { locale } = useTranslation();
  const zh = locale === 'zh';
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [status, setStatus] = useState('');
  const busy = vault.busy;

  const loadStatus = !vault.available
    ? (zh ? '加密凭据库不可用' : 'Encrypted credential vault is unavailable')
    : vault.loadError === 'ipc'
      ? (zh ? '无法连接加密凭据库，请重试。' : 'The encrypted credential vault could not be reached. Try again.')
      : vault.loadError
        ? `${zh ? '无法读取凭据元数据' : 'Credential metadata unavailable'}: ${vault.loadError}`
        : '';

  const save = async () => {
    const result = await vault.save(name.trim(), value);
    if (!result.ok) {
      setStatus(result.transport
        ? (zh ? '保存未完成，凭据值仍保留在输入框中，可直接重试。' : 'Save did not complete. The credential value remains in the field so you can retry.')
        : `${zh ? '保存失败' : 'Save failed'}: ${result.code}`);
      return;
    }
    setValue('');
    setName('');
    setStatus(zh ? '凭据已由操作系统加密保存；值不会回显' : 'Credential encrypted by the operating system; values are never displayed');
  };

  const remove = async (secretName: string) => {
    const result = await vault.remove(secretName);
    if (!result.ok) {
      setStatus(result.transport
        ? (zh ? '删除未完成，请重试。' : 'Remove did not complete. Try again.')
        : `${zh ? '删除失败' : 'Remove failed'}: ${result.code}`);
      return;
    }
    setStatus(zh ? '凭据已删除' : 'Credential removed');
  };

  return <section className="personalization-installer" aria-label={zh ? '加密凭据库' : 'Encrypted credential vault'}>
    <div className="personalization-installer__header">
      <div><span className="personalization-eyebrow">{zh ? '凭据' : 'SECRETS'}</span><h2>{zh ? 'MCP 凭据' : 'MCP credentials'}</h2></div>
      <span>{zh ? '值仅在主进程通过系统安全存储加密；界面和配置包只使用 ${secret:NAME} 引用。' : 'Values are encrypted through OS secure storage in the main process; UI and bundles use only ${secret:NAME} references.'}</span>
    </div>
    {/* 刘总反馈（2026-10）：全局面板弱化为后备，说明这是不归属任何具体 MCP 的通用凭据。 */}
    <p className="personalization-installer__mode-help">{zh ? '通用凭据（不属于任何具体 MCP）。单个 MCP 的凭据请在该 MCP 条目的「凭据」入口录入。' : 'Shared credentials (not tied to any specific MCP). Enter per-MCP credentials from the "Credentials" entry on each MCP item.'}</p>
    <div className="personalization-grid personalization-grid--2">
      <label><span>{zh ? '环境变量名称' : 'Environment name'}</span><input value={name} onChange={(event) => setName(event.target.value.toUpperCase())} placeholder="ZOTERO_API_KEY" autoComplete="off" spellCheck={false} /></label>
      <label><span>{zh ? '凭据值' : 'Credential value'}</span><input type="password" value={value} onChange={(event) => setValue(event.target.value)} autoComplete="new-password" /></label>
    </div>
    <div className="personalization-actions"><button className="btn-primary" type="button" disabled={busy || !name.trim() || !value} onClick={() => void save()}>{zh ? '加密保存' : 'Save encrypted'}</button><span role="status" aria-live="polite">{status || loadStatus}</span></div>
    <div className="personalization-cards">
      {vault.secrets.map((secret) => <article className="personalization-card" key={secret.name}>
        <div className="personalization-card__select"><strong>{secret.name}</strong><span>{zh ? '值已隐藏' : 'Value hidden'} · {new Date(secret.updatedAt).toLocaleString()}</span></div>
        <div className="personalization-card__actions"><button type="button" disabled={busy} onClick={() => void remove(secret.name)}>{zh ? '删除' : 'Remove'}</button></div>
      </article>)}
      {vault.secrets.length === 0 && <p className="personalization-empty">{zh ? '还没有保存凭据。' : 'No credentials saved.'}</p>}
    </div>
  </section>;
}
