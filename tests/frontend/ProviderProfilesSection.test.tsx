/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProviderProfilesSection from '../../src/components/ProviderProfilesSection';

const profile = (overrides: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Qwen research',
  baseUrl: 'https://example.test/v1',
  model: 'qwen3.5-122b-a10b',
  vision: false,
  maxContextTokens: 131072,
  apiKeyStored: true,
  isActive: true,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

function okList(profiles: unknown[], revision = 1) {
  return { ok: true, contractVersion: 1, operationId: 'list', revision, profiles };
}

describe('ProviderProfilesSection', () => {
  const list = vi.fn();
  const save = vi.fn();
  const switchProfile = vi.fn();
  const deleteProfile = vi.fn();
  const probe = vi.fn();

  beforeEach(() => {
    list.mockReset();
    save.mockReset();
    switchProfile.mockReset();
    deleteProfile.mockReset();
    probe.mockReset();
    localStorage.clear();
    (window as unknown as { metis: unknown }).metis = {
      providerProfilesList: list,
      providerProfilesSave: save,
      providerProfilesSwitch: switchProfile,
      providerProfilesDelete: deleteProfile,
      setupProbe: probe,
    };
  });

  it('lists saved connections and marks the active one', async () => {
    list.mockResolvedValue(okList([
      profile(),
      profile({ id: '22222222-2222-4222-8222-222222222222', name: 'OpenAI', model: 'gpt-4o', isActive: false }),
    ]));
    render(<ProviderProfilesSection />);
    expect(await screen.findByText('Qwen research')).toBeTruthy();
    expect(screen.getByText('OpenAI')).toBeTruthy();
    expect(screen.getByText('当前')).toBeTruthy();
  });

  it('saves a new connection without ever echoing the key in the notice', async () => {
    list.mockResolvedValue(okList([profile()], 1));
    save.mockResolvedValue({ ok: true, contractVersion: 1, operationId: 'save', action: 'saved', revision: 2, profile: profile(), activeId: profile().id });
    render(<ProviderProfilesSection />);
    fireEvent.click(await screen.findByTestId('provider-profile-new'));
    fireEvent.change(screen.getByLabelText('连接名称'), { target: { value: 'Local GLM' } });
    fireEvent.change(screen.getByLabelText('API 地址'), { target: { value: 'http://127.0.0.1:8000/v1' } });
    fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'glm-4.5' } });
    fireEvent.change(screen.getByLabelText('API 密钥'), { target: { value: 'never-should-leak-12345' } });
    fireEvent.click(screen.getByTestId('provider-profile-save'));

    await waitFor(() => expect(save).toHaveBeenCalled());
    const request = save.mock.calls[0]![0] as { newApiKey?: string; keyMode: string };
    expect(request.keyMode).toBe('replace');
    expect(request.newApiKey).toBe('never-should-leak-12345');
    await waitFor(() => expect(screen.queryByText(/never-should-leak-12345/)).toBeNull());
    expect(screen.getByRole('status').textContent).toContain('已安全保存');
  });

  it('cannot delete the active connection without switching first', async () => {
    list.mockResolvedValue(okList([profile()], 1));
    render(<ProviderProfilesSection />);
    fireEvent.click(await screen.findByRole('button', { name: '删除 Qwen research' }));
    await waitFor(() => expect(deleteProfile).not.toHaveBeenCalled());
    expect(screen.getByRole('status').textContent).toContain('当前连接不能直接删除');
  });

  it('switches to a different connection', async () => {
    const inactive = profile({ id: '22222222-2222-4222-8222-222222222222', name: 'OpenAI', model: 'gpt-4o', isActive: false });
    let currentProfiles = [profile(), inactive];
    list.mockImplementation(() => Promise.resolve(okList(currentProfiles, 1)));
    switchProfile.mockImplementation(async () => {
      currentProfiles = [profile({ isActive: false }), { ...inactive, isActive: true }];
      return { ok: true, contractVersion: 1, operationId: 'switch', action: 'switched', revision: 2, profile: { ...inactive, isActive: true }, activeId: inactive.id };
    });
    render(<ProviderProfilesSection />);
    fireEvent.click(await screen.findByRole('button', { name: '切换' }));
    await waitFor(() => expect(switchProfile).toHaveBeenCalledWith(expect.objectContaining({ id: inactive.id })));
    expect((await screen.findAllByRole('status')).some((element) => element.textContent?.includes('已切换至「OpenAI」'))).toBe(true);
  });
});
