/**
 * SettingsDiagnosticSection — MCP servers + HITL approval rules.
 *
 * Only rendered when diagnostic mode is enabled. Migrated from the
 * inline App.tsx SettingsPage. Contains all MCP add/remove/toggle/test
 * and HITL rule toggle functionality.
 */

import { useState, useEffect } from 'react';
import { useTranslation } from '../i18n';

interface McpServer {
  id: string;
  name: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

interface HitlRule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

export default function SettingsDiagnosticSection() {
  const { t } = useTranslation();

  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [showMcpForm, setShowMcpForm] = useState(false);
  const [mcpName, setMcpName] = useState('');
  const [mcpCommand, setMcpCommand] = useState('');
  const [mcpArgs, setMcpArgs] = useState('');
  const [mcpTestResult, setMcpTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [mcpTestLoading, setMcpTestLoading] = useState(false);

  const [hitlRules, setHitlRules] = useState<HitlRule[]>([]);

  async function loadMCPServers() {
    const metis = window.metis;
    if (metis?.listMCPServers) {
      try {
        const servers = await metis.listMCPServers();
        setMcpServers(servers);
      } catch (err) { console.warn('Failed to load MCP servers:', err); }
    }
  }

  async function loadHitlRules() {
    const metis = window.metis;
    if (metis?.listHITLRules) {
      try {
        const rules = await metis.listHITLRules();
        setHitlRules(rules);
      } catch (err) { console.warn('Failed to load HITL rules:', err); }
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async loaders, setState in .then()
    void loadMCPServers();
    void loadHitlRules();
  }, []);

  const handleAddMcpServer = async () => {
    if (!mcpName.trim() || !mcpCommand.trim()) return;
    const metis = window.metis;
    if (!metis?.addMCPServer) return;
    try {
      await metis.addMCPServer({
        id: `mcp_${Date.now()}`,
        name: mcpName.trim(),
        command: mcpCommand.trim(),
        args: mcpArgs.trim().split(/\s+/).filter(Boolean),
        env: {},
        enabled: true,
      });
      setMcpName('');
      setMcpCommand('');
      setMcpArgs('');
      setShowMcpForm(false);
      setMcpTestResult(null);
      await loadMCPServers();
    } catch (err) { console.warn('Failed to add MCP server:', err); }
  };

  const handleRemoveMcpServer = async (id: string) => {
    const metis = window.metis;
    if (!metis?.removeMCPServer) return;
    try {
      await metis.removeMCPServer(id);
      await loadMCPServers();
    } catch (err) { console.warn('Failed to remove MCP server:', err); }
  };

  const handleToggleMcpServer = async (id: string, enabled: boolean) => {
    const metis = window.metis;
    if (!metis?.toggleMCPServer) return;
    try {
      await metis.toggleMCPServer(id, !enabled);
      await loadMCPServers();
    } catch (err) { console.warn('Failed to toggle MCP server:', err); }
  };

  const handleToggleHitlRule = async (id: string, enabled: boolean) => {
    const metis = window.metis;
    if (!metis?.toggleHITLRule) return;
    try {
      await metis.toggleHITLRule(id, !enabled);
      await loadHitlRules();
    } catch (err) { console.warn('Failed to toggle HITL rule:', err); }
  };

  const handleTestMcpServer = async () => {
    if (!mcpCommand.trim()) return;
    setMcpTestLoading(true);
    setMcpTestResult(null);
    const metis = window.metis;
    if (!metis?.testMCPServer) {
      setMcpTestLoading(false);
      return;
    }
    try {
      const result = await metis.testMCPServer({
        command: mcpCommand.trim(),
        args: mcpArgs.trim().split(/\s+/).filter(Boolean),
        env: {},
      });
      if (result.success) {
        setMcpTestResult({
          success: true,
          message: t('settings.mcpServerTestSuccess').replace('{count}', '0'),
        });
      } else {
        setMcpTestResult({
          success: false,
          message: t('settings.mcpServerTestFailed').replace('{error}', result.code ?? 'Unknown error'),
        });
      }
    } catch (err) {
      setMcpTestResult({
        success: false,
        message: t('settings.mcpServerTestFailed').replace('{error}', err instanceof Error ? err.message : String(err)),
      });
    }
    setMcpTestLoading(false);
  };

  return (
    <>
      <div className="settings-group" data-testid="diagnostic-mcp-settings">
        <h3>{t('settings.mcpServers')}</h3>
        <p>{t('settings.mcpServersDescription')}</p>

        {mcpServers.length === 0 && (
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('settings.mcpServerNoServers')}</p>
        )}

        {mcpServers.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            {mcpServers.map((srv) => (
              <div key={srv.id} style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px',
                border: '1px solid var(--border)', borderRadius: 6, marginBottom: 8,
                background: 'var(--bg-secondary)',
              }}>
                <span style={{
                  width: 10, height: 10, borderRadius: '50%',
                  background: srv.connected ? 'var(--status-completed)' : srv.error ? 'var(--status-failed)' : 'var(--text-secondary)',
                }} />
                <span style={{ fontWeight: 500, flex: 1 }}>{srv.name}</span>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  {srv.connected
                    ? t('settings.mcpServerTools').replace('{count}', String(srv.toolCount))
                    : srv.error
                      ? t('settings.mcpServerStatusError')
                      : t('settings.mcpServerStatusDisconnected')}
                </span>
                <button
                  className="btn-secondary"
                  style={{ fontSize: 12, padding: '4px 8px' }}
                  onClick={() => handleToggleMcpServer(srv.id, srv.connected || false)}
                >
                  {srv.connected || false ? t('common.disable') : t('common.enable')}
                </button>
                <button
                  className="btn-secondary"
                  style={{ fontSize: 12, padding: '4px 8px', color: 'var(--status-failed)' }}
                  onClick={() => handleRemoveMcpServer(srv.id)}
                >
                  {t('settings.mcpServerDelete')}
                </button>
              </div>
            ))}
          </div>
        )}

        {!showMcpForm && (
          <button className="btn-secondary" onClick={() => setShowMcpForm(true)}>
            {t('settings.addMcpServer')}
          </button>
        )}

        {showMcpForm && (
          <div style={{
            border: '1px solid var(--border)', borderRadius: 8, padding: 16,
            background: 'var(--bg-secondary)', marginTop: 12,
          }}>
            <h4 style={{ margin: '0 0 12px' }}>{t('settings.mcpServerAddTitle')}</h4>
            <label style={{ display: 'block', marginBottom: 8 }}>
              {t('settings.mcpServerName')}
              <input
                type="text" value={mcpName} onChange={(e) => setMcpName(e.target.value)}
                className="settings-input" placeholder={t('settings.mcpServerNamePlaceholder')}
                style={{ marginLeft: 8 }}
              />
            </label>
            <label style={{ display: 'block', marginBottom: 8 }}>
              {t('settings.mcpServerCommand')}
              <input
                type="text" value={mcpCommand} onChange={(e) => setMcpCommand(e.target.value)}
                className="settings-input" placeholder={t('settings.mcpServerCommandPlaceholder')}
                style={{ marginLeft: 8 }}
              />
            </label>
            <label style={{ display: 'block', marginBottom: 8 }}>
              {t('settings.mcpServerArgs')}
              <input
                type="text" value={mcpArgs} onChange={(e) => setMcpArgs(e.target.value)}
                className="settings-input" placeholder={t('settings.mcpServerArgsPlaceholder')}
                style={{ marginLeft: 8 }}
              />
            </label>
            {mcpTestResult && (
              <p style={{
                fontSize: 12, marginTop: 8,
                color: mcpTestResult.success ? 'var(--status-completed)' : 'var(--status-failed)',
              }}>
                {mcpTestResult.message}
              </p>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button
                className="btn-primary"
                onClick={handleAddMcpServer}
                disabled={!mcpName.trim() || !mcpCommand.trim()}
              >
                {t('common.add')}
              </button>
              <button
                className="btn-secondary"
                onClick={handleTestMcpServer}
                disabled={!mcpCommand.trim() || mcpTestLoading}
              >
                {mcpTestLoading ? t('common.testing') : t('settings.mcpServerTest')}
              </button>
              <button
                className="btn-secondary"
                onClick={() => { setShowMcpForm(false); setMcpTestResult(null); }}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="settings-group" data-testid="diagnostic-hitl-settings">
        <h3>{t('settings.hitlRules')}</h3>
        <p>{t('settings.hitlRulesDescription')}</p>

        {hitlRules.length === 0 && (
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('settings.hitlRulesNoRules')}</p>
        )}

        {hitlRules.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {hitlRules.map((rule) => (
              <div
                key={rule.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px',
                  border: '1px solid var(--border)', borderRadius: 6,
                  background: 'var(--bg-secondary)',
                }}
              >
                <span style={{
                  width: 10, height: 10, borderRadius: '50%',
                  background: rule.enabled ? 'var(--status-completed)' : 'var(--text-secondary)',
                }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500 }}>{rule.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{rule.description}</div>
                </div>
                <button
                  className="btn-secondary"
                  style={{ fontSize: 12, padding: '4px 8px' }}
                  onClick={() => handleToggleHitlRule(rule.id, rule.enabled)}
                  data-testid={`hitl-toggle-${rule.id}`}
                >
                  {rule.enabled ? t('common.disable') : t('common.enable')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
