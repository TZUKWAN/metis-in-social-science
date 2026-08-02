/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const searchZoteroMock = vi.fn();

vi.mock('@engine/research/ZoteroClient.js', () => ({
  searchZoteroLibrary: (opts: unknown) => searchZoteroMock(opts),
}));

describe('ZoteroSettingsSection', () => {
  beforeEach(() => {
    searchZoteroMock.mockReset();
    localStorage.clear();
    (window as unknown as { metis: unknown }).metis = {
      listPersonalizationSecrets: vi.fn(async () => ({ ok: true, revision: 5, secrets: [] })),
      setPersonalizationSecret: vi.fn(async () => ({ ok: true, revision: 6 })),
      removePersonalizationSecret: vi.fn(async () => ({ ok: true, revision: 7 })),
    };
  });

  it('renders the configuration fields and save button', async () => {
    const { ZoteroSettingsSection } = await import('../../src/components/ZoteroSettingsSection');
    const { findByText, getByPlaceholderText } = render(<ZoteroSettingsSection />);
    expect(await findByText(/Zotero Library Sync|Zotero 文献库同步/)).toBeTruthy();
    expect(getByPlaceholderText(/12345/)).toBeTruthy();
  });

  it('persists ids to localStorage and the key to the vault on save', async () => {
    const { ZoteroSettingsSection } = await import('../../src/components/ZoteroSettingsSection');
    const { findByPlaceholderText, findByText } = render(<ZoteroSettingsSection />);

    const userIdInput = await findByPlaceholderText(/12345/);
    fireEvent.change(userIdInput, { target: { value: '999' } });
    const keyInput = await findByPlaceholderText(/Paste your Zotero API key|粘贴你的 Zotero API 密钥/);
    fireEvent.change(keyInput, { target: { value: 'secret-key' } });

    const saveBtn = await findByText(/Save|保存/);
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(localStorage.getItem('metis:zoteroUserId')).toBe('999');
    });
    expect(window.metis.setPersonalizationSecret).toHaveBeenCalled();
  });

  it('tests the connection with the entered key', async () => {
    searchZoteroMock.mockResolvedValue({ items: [], totalResults: 42 });
    const { ZoteroSettingsSection } = await import('../../src/components/ZoteroSettingsSection');
    const { findByPlaceholderText, findByText } = render(<ZoteroSettingsSection />);

    fireEvent.change(await findByPlaceholderText(/12345/), { target: { value: '999' } });
    fireEvent.change(await findByPlaceholderText(/Paste your Zotero API key|粘贴你的 Zotero API 密钥/), { target: { value: 'probe-key' } });

    const testBtn = await findByText(/Test connection|测试连接/);
    fireEvent.click(testBtn);

    await waitFor(() => expect(searchZoteroMock).toHaveBeenCalled());
    const call = searchZoteroMock.mock.calls[0]![0] as { apiKey: string; userId: string };
    expect(call.apiKey).toBe('probe-key');
    expect(call.userId).toBe('999');
  });
});
