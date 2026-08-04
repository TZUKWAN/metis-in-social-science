/**
 * OfficeDocumentPage: status detection, document creation flow, quick-edit
 * panel, and AI natural-language edit. IPC is mocked (no real officecli).
 *
 * @vitest-environment jsdom
 */

import { render, waitFor, fireEvent, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('OfficeDocumentPage', () => {
  beforeEach(() => {
    window.metis = {
      officeCliStatus: vi.fn().mockResolvedValue({ available: true, binary: 'officecli', version: '1.0.143' }),
      officeCliNewDocument: vi.fn().mockResolvedValue({ success: true, filePath: 'C:\\docs\\doc-abc.docx' }),
      officeCliStartWatch: vi.fn().mockResolvedValue({ success: true, url: 'http://localhost:26315', port: 26315 }),
      officeCliStopWatch: vi.fn().mockResolvedValue({ success: true }),
      officeCliClose: vi.fn().mockResolvedValue({ success: true }),
      officeCliRevealFile: vi.fn().mockResolvedValue({ success: true }),
      officeCliAdd: vi.fn().mockResolvedValue({ success: true }),
      officeCliSet: vi.fn().mockResolvedValue({ success: true }),
      officeCliOpen: vi.fn().mockResolvedValue({ success: true }),
      officeCliRenderHtml: vi.fn().mockResolvedValue({ success: true, data: '<html><body>preview</body></html>' }),
      aiSynthesis: vi.fn().mockResolvedValue({ ok: true, text: '[{"op":"add","parent":"/body","type":"paragraph","props":{"text":"AI 插入的段落"}}]' }),
      officeCliAiEdit: vi.fn().mockResolvedValue({ ok: true, plan: [{ op: 'add', parent: '/body', type: 'paragraph', props: { text: 'AI 插入的段落' } }] }),
    } as unknown as typeof window.metis;
  });

  it('detects officecli availability on mount', async () => {
    const { default: OfficeDocumentPage } = await import('../../src/pages/OfficeDocumentPage');
    const { container } = render(<OfficeDocumentPage />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="office-status-ok"]')).toBeTruthy();
    });
    expect(container.textContent).toContain('OfficeCli 已就绪');
  });

  it('creates a new Word document and starts the live preview', async () => {
    const { default: OfficeDocumentPage } = await import('../../src/pages/OfficeDocumentPage');
    const { container } = render(<OfficeDocumentPage />);
    await waitFor(() => {
      expect((container.querySelector('[data-testid="office-new-docx"]') as HTMLButtonElement).disabled).toBe(false);
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="office-new-docx"]')!);
    });
    expect(window.metis?.officeCliNewDocument).toHaveBeenCalledWith('docx', undefined);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="office-preview"]')).toBeTruthy();
    });
    expect(container.querySelector('[data-testid="office-docname"]')?.textContent).toContain('doc-abc.docx');
  });

  it('inserts a paragraph via the quick-edit panel', async () => {
    const { default: OfficeDocumentPage } = await import('../../src/pages/OfficeDocumentPage');
    const { container } = render(<OfficeDocumentPage />);
    await waitFor(() => {
      expect((container.querySelector('[data-testid="office-new-docx"]') as HTMLButtonElement).disabled).toBe(false);
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="office-new-docx"]')!);
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="office-edit-panel"]')).toBeTruthy();
    });
    const input = container.querySelector('[data-testid="office-paragraph-input"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: '第一段内容' } });
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="office-apply-quick"]')!);
    });
    expect(window.metis?.officeCliAdd).toHaveBeenCalledWith(expect.objectContaining({
      filePath: 'C:\\docs\\doc-abc.docx',
      parent: '/',
      type: 'paragraph',
      props: expect.objectContaining({ text: '第一段内容' }),
    }));
  });

  it('runs an AI natural-language edit', async () => {
    const { default: OfficeDocumentPage } = await import('../../src/pages/OfficeDocumentPage');
    const { container } = render(<OfficeDocumentPage />);
    await waitFor(() => {
      expect((container.querySelector('[data-testid="office-new-docx"]') as HTMLButtonElement).disabled).toBe(false);
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="office-new-docx"]')!);
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="office-ai-instruction"]')).toBeTruthy();
    });
    const input = container.querySelector('[data-testid="office-ai-instruction"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: '加一段说明' } });
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="office-ai-apply"]')!);
    });
    await waitFor(() => {
      expect(window.metis?.officeCliAiEdit).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(window.metis?.officeCliAdd).toHaveBeenCalledWith(expect.objectContaining({
        type: 'paragraph',
        props: expect.objectContaining({ text: 'AI 插入的段落' }),
      }));
    });
  });

  it('shows the not-installed state when officecli is missing', async () => {
    (window.metis as unknown as { officeCliStatus: unknown }).officeCliStatus =
      vi.fn().mockResolvedValue({ available: false, binary: '', error: 'not found' });
    const { default: OfficeDocumentPage } = await import('../../src/pages/OfficeDocumentPage');
    const { container } = render(<OfficeDocumentPage />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="office-status-missing"]')).toBeTruthy();
    });
    expect((container.querySelector('[data-testid="office-new-docx"]') as HTMLButtonElement).disabled).toBe(true);
  });
});
