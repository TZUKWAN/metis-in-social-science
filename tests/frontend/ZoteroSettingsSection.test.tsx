/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('ZoteroSettingsSection', () => {
  const importZotero = vi.fn();
  const probeZotero = vi.fn();
  const setSecret = vi.fn();
  const removeSecret = vi.fn();
  const listSecrets = vi.fn();

  beforeEach(() => {
    importZotero.mockReset();
    probeZotero.mockReset();
    setSecret.mockReset().mockResolvedValue({ ok: true, revision: 6 });
    removeSecret.mockReset().mockResolvedValue({ ok: true, revision: 7 });
    listSecrets.mockReset().mockResolvedValue({ ok: true, revision: 5, secrets: [] });
    localStorage.clear();
    (window as unknown as { metis: unknown }).metis = {
      listPersonalizationSecrets: listSecrets,
      setPersonalizationSecret: setSecret,
      removePersonalizationSecret: removeSecret,
      importZotero,
      probeZotero,
    };
  });

  it('renders the connection fields with an explicit library type', async () => {
    const { ZoteroSettingsSection } = await import('../../src/components/ZoteroSettingsSection');
    render(<ZoteroSettingsSection />);
    expect(await screen.findByRole('heading', { name: /Zotero 文献库同步|Zotero Library Sync/ })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: /文献库类型|Library type/ })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: /用户 ID|User ID/ })).toBeTruthy();
  });

  it('switching to a group library relabels the ID field', async () => {
    const { ZoteroSettingsSection } = await import('../../src/components/ZoteroSettingsSection');
    render(<ZoteroSettingsSection />);
    await screen.findByRole('heading', { name: /Zotero/ });
    fireEvent.change(screen.getByRole('combobox', { name: /文献库类型|Library type/ }), { target: { value: 'group' } });
    expect(screen.getByRole('textbox', { name: /群组 ID|Group ID/ })).toBeTruthy();
  });

  it('persists library identity to localStorage and the key to the vault on save', async () => {
    const { ZoteroSettingsSection } = await import('../../src/components/ZoteroSettingsSection');
    render(<ZoteroSettingsSection />);
    await screen.findByRole('heading', { name: /Zotero/ });

    fireEvent.change(screen.getByRole('textbox', { name: /用户 ID|User ID/ }), { target: { value: '999' } });
    const keyInput = screen.getByLabelText(/API 密钥|API key/) as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: 'secret-key' } });

    fireEvent.click(screen.getByRole('button', { name: /保存连接|Save connection/ }));

    await waitFor(() => {
      expect(localStorage.getItem('metis:zoteroLibraryType')).toBe('personal');
      expect(localStorage.getItem('metis:zoteroLibraryId')).toBe('999');
    });
    expect(setSecret).toHaveBeenCalledWith(expect.objectContaining({ name: 'ZOTERO_API_KEY', value: 'secret-key' }));
  });

  it('syncs through the main process with an explicit library identity', async () => {
    importZotero.mockResolvedValue({ ok: true, imported: 3, merged: 1, skipped: 0 });
    listSecrets.mockResolvedValue({ ok: true, revision: 1, secrets: [{ name: 'ZOTERO_API_KEY', createdAt: 1, updatedAt: 1 }] });
    localStorage.setItem('metis:zoteroLibraryType', 'group');
    localStorage.setItem('metis:zoteroLibraryId', '67890');
    const { ZoteroSettingsSection } = await import('../../src/components/ZoteroSettingsSection');
    render(<ZoteroSettingsSection />);

    fireEvent.click(await screen.findByRole('button', { name: /同步到资料库|Sync to library/ }));

    await waitFor(() => expect(importZotero).toHaveBeenCalledWith(expect.objectContaining({ libraryType: 'group', libraryId: '67890' })));
    const statuses = await screen.findAllByRole('status');
    expect(statuses.some((element) => element.textContent?.includes('新增 3 · 合并 1 · 跳过 0'))).toBe(true);
  });

  it('probes the connection through the main process with the saved key', async () => {
    probeZotero.mockResolvedValue({ ok: true, totalResults: 42 });
    listSecrets.mockResolvedValue({ ok: true, revision: 1, secrets: [{ name: 'ZOTERO_API_KEY', createdAt: 1, updatedAt: 1 }] });
    localStorage.setItem('metis:zoteroLibraryType', 'group');
    localStorage.setItem('metis:zoteroLibraryId', '67890');
    const { ZoteroSettingsSection } = await import('../../src/components/ZoteroSettingsSection');
    render(<ZoteroSettingsSection />);

    fireEvent.click(await screen.findByRole('button', { name: /检测连接|Probe connection/ }));

    await waitFor(() => expect(probeZotero).toHaveBeenCalledWith({ libraryType: 'group', libraryId: '67890' }));
    const statuses = await screen.findAllByRole('status');
    expect(statuses.some((element) => element.textContent?.includes('42'))).toBe(true);
  });

  it('never calls a renderer-side Zotero client for probing', async () => {
    const { ZoteroSettingsSection } = await import('../../src/components/ZoteroSettingsSection');
    render(<ZoteroSettingsSection />);
    await screen.findByRole('heading', { name: /Zotero/ });
    expect(screen.queryByRole('button', { name: /Test connection|测试连接/ })).toBeNull();
  });
});
