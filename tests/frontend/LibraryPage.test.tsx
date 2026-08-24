/**
 * LibraryPage — 内置文献检索 + 我的文献管理（LIT-SEARCH-01）。
 *
 * 覆盖：检索区结构、桥接调用与结果渲染、导入文献库、部分来源失败提示、
 * 服务不可用降级；以及无 PDF 条目的题录详情、编辑保存、收藏、删除、
 * 搜索过滤与阅读入口。
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, screen } from '@testing-library/react';
import LibraryPage from '../../src/pages/LibraryPage';
import { useMetisStore } from '../../src/store';
import type { PaperItem } from '../../engine/research/PaperItem';
import { researchWorkspaceStore } from '../../src/research/researchWorkspaceStore';

type SearchRequest = { query: string; sources: Array<'ncpssd' | 'openalex'>; page?: number; pageSize?: number; coreOnly?: boolean };

interface SearchItemFixture {
  id: string;
  source: 'ncpssd' | 'openalex';
  title: string;
  authors: string[];
  year: number;
  venue: string;
  abstract: string;
  doi?: string;
  url?: string;
  pdfUrl?: string;
  citationCount?: number;
  tags: string[];
  core: boolean;
}

function makeItem(overrides?: Partial<SearchItemFixture>): SearchItemFixture {
  return {
    id: 'ncpssd:fixture-1',
    source: 'ncpssd',
    title: '论中国式现代化的制度基础',
    authors: ['张三', '李四'],
    year: 2024,
    venue: '中国社会科学',
    abstract: '摘要……',
    url: 'https://www.ncpssd.org/Literature/articleinfo?id=fixture-1',
    tags: ['现代化', '制度'],
    core: true,
    ...overrides,
  };
}

function makePaper(overrides?: Partial<PaperItem>): PaperItem {
  return {
    id: 'paper-existing-1',
    title: '已采集的知网文献',
    authors: [],
    year: 0,
    venue: '',
    abstract: '网页采集的摘要',
    pdfUrl: 'https://kns.cnki.net/example',
    tags: ['collected'],
    notes: '',
    readStatus: 'unread',
    rating: 0,
    referenceIds: [],
    addedAt: 1786342336497,
    ...overrides,
  };
}

const literatureSearch = vi.fn();
const savePaper = vi.fn(async () => true);
const deletePaper = vi.fn(async () => true);
const linkPaperToProject = vi.fn(async () => ({ ok: true }));
const browserNavigate = vi.fn(async () => ({ ok: true }));
const browserShow = vi.fn(async () => ({ ok: true }));
const browserHide = vi.fn(async () => ({ ok: true }));
const browserSetBounds = vi.fn(async () => ({ ok: true }));
const browserListDownloads = vi.fn(async () => []);
const onBrowserState = vi.fn(() => () => {});
const onBrowserDownloadRequest = vi.fn(() => () => {});

function browserMetisMock() {
  return {
    literatureSearch, savePaper, deletePaper, linkPaperToProject,
    browserNavigate, browserShow, browserHide, browserSetBounds, browserListDownloads,
    onBrowserState, onBrowserDownloadRequest,
  } as unknown as typeof window.metis;
}

function seedPapers(papers: PaperItem[]) {
  useMetisStore.setState({ papers });
}

function resetStore() {
  useMetisStore.setState({
    papers: [],
    paperFilter: { query: '' },
    notes: [],
    selectedNote: null,
    experiments: [],
    collections: [],
    selectedCollection: null,
    workflowRuns: [],
    selectedPaperId: null,
    locale: 'zh',
    theme: 'light',
    isHydrated: true,
  });
  researchWorkspaceStore.setState({ activeProjectId: null });
}

describe('LibraryPage — 检索区', () => {
  beforeEach(() => {
    resetStore();
    literatureSearch.mockReset();
    savePaper.mockClear();
    window.metis = { literatureSearch, savePaper } as unknown as typeof window.metis;
  });

  afterEach(() => {
    cleanup();
    delete (window as { metis?: unknown }).metis;
  });

  it('渲染检索区与我的文献空状态', () => {
    render(<LibraryPage />);
    expect(screen.getByTestId('library-search-input')).toBeTruthy();
    expect(screen.getByTestId('library-search-submit')).toBeTruthy();
    expect(screen.getByTestId('library-source-ncpssd')).toBeTruthy();
    expect(screen.getByTestId('library-source-openalex')).toBeTruthy();
    expect(screen.getByTestId('library-core-only')).toBeTruthy();
    expect(screen.getByTestId('library-empty')).toBeTruthy();
  });

  it('检索成功时渲染结果并传递核心过滤参数', async () => {
    const item = makeItem();
    literatureSearch.mockResolvedValue({ ok: true, results: [item], total: 42, warnings: [] });
    render(<LibraryPage />);

    fireEvent.change(screen.getByTestId('library-search-input'), { target: { value: '现代化' } });
    fireEvent.click(screen.getByTestId('library-search-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('library-results')).toBeTruthy();
    });
    const request = literatureSearch.mock.calls[0]![0] as SearchRequest;
    expect(request.query).toBe('现代化');
    expect(request.sources).toEqual(['ncpssd', 'openalex']);
    expect(request.coreOnly).toBe(true);
    expect(screen.getByText('论中国式现代化的制度基础')).toBeTruthy();
  });

  it('导入结果条目时写入本地文献库并标记已导入', async () => {
    const item = makeItem({ id: 'ncpssd:import-1' });
    literatureSearch.mockResolvedValue({ ok: true, results: [item], total: 1, warnings: [] });
    render(<LibraryPage />);

    fireEvent.change(screen.getByTestId('library-search-input'), { target: { value: '现代化' } });
    fireEvent.click(screen.getByTestId('library-search-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('library-import')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('library-import'));
    await waitFor(() => {
      expect(screen.getByTestId('library-paper-item')).toBeTruthy();
      expect(screen.getByTestId('library-import').textContent).toContain('已导入');
    });
    expect(savePaper).toHaveBeenCalledTimes(1);
    const saved = savePaper.mock.calls[0]![0] as { title: string; venue: string; projectId?: string };
    expect(saved.title).toBe('论中国式现代化的制度基础');
    expect(saved.venue).toBe('中国社会科学');
    expect(saved.projectId).toBeUndefined();
  });

  it('检索失败时展示错误且不渲染结果', async () => {
    literatureSearch.mockResolvedValue({ ok: false, code: 'literature_source_unavailable', recovery: 'retry_later' });
    render(<LibraryPage />);

    fireEvent.change(screen.getByTestId('library-search-input'), { target: { value: '现代化' } });
    fireEvent.click(screen.getByTestId('library-search-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('library-search-error')).toBeTruthy();
    });
    expect(document.querySelector('[data-testid="library-results"]')).toBeNull();
  });

  it('桥接不可用时给出降级提示', async () => {
    delete (window as { metis?: unknown }).metis;
    render(<LibraryPage />);

    fireEvent.change(screen.getByTestId('library-search-input'), { target: { value: '现代化' } });
    fireEvent.click(screen.getByTestId('library-search-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('library-search-error')).toBeTruthy();
    });
    expect(literatureSearch).not.toHaveBeenCalled();
  });
});

describe('LibraryPage — 我的文献', () => {
  beforeEach(() => {
    resetStore();
    literatureSearch.mockReset();
    savePaper.mockClear();
    deletePaper.mockClear();
    linkPaperToProject.mockClear();
    browserNavigate.mockClear();
    browserShow.mockClear();
    browserHide.mockClear();
    browserListDownloads.mockClear().mockResolvedValue([]);
    window.metis = browserMetisMock();
    seedPapers([
      makePaper(),
      makePaper({
        id: 'paper-existing-2',
        title: 'Multiple intermediate phases in the Aubry-André model',
        authors: ['Guo, Chenyue'],
        year: 2024,
        venue: 'Physical Review B',
        doi: '10.1103/PhysRevB.109.174203',
        pdfUrl: 'https://arxiv.org/abs/2401.17000',
        tags: ['collected', '物理'],
        readStatus: 'reading',
        rating: 4,
        starred: true,
        addedAt: 1786347983187,
      }),
    ]);
  });

  afterEach(() => {
    cleanup();
    delete (window as { metis?: unknown }).metis;
  });

  it('渲染工具条与文献列表，无 PDF 条目不再是禁用按钮', () => {
    render(<LibraryPage />);
    expect(screen.getByTestId('library-toolbar')).toBeTruthy();
    expect(screen.getByTestId('library-filter-input')).toBeTruthy();
    expect(screen.getByTestId('library-sort-select')).toBeTruthy();
    expect(screen.getByTestId('library-status-select')).toBeTruthy();
    const items = screen.getAllByTestId('library-paper-item');
    expect(items).toHaveLength(2);
    for (const open of screen.getAllByTestId('library-paper-open')) {
      expect((open as HTMLButtonElement).disabled).toBe(false);
    }
    // 无本地 PDF 的条目不显示阅读按钮，但仍可打开原文链接。
    const readButtons = screen.queryAllByTestId('library-paper-read');
    expect(readButtons).toHaveLength(0);
    expect(screen.getAllByTestId('library-paper-source')).toHaveLength(2);
  });

  it('点击无 PDF 条目打开题录详情并展示全部字段', async () => {
    render(<LibraryPage />);
    fireEvent.click(screen.getByRole('button', { name: /已采集的知网文献/ }));

    await waitFor(() => {
      expect(screen.getByTestId('library-detail')).toBeTruthy();
    });
    expect(screen.getByTestId('library-detail').textContent).toContain('已采集的知网文献');
    expect(screen.getByTestId('library-detail').textContent).toContain('未知作者');
    expect(screen.getByTestId('library-detail').textContent).toContain('网页采集的摘要');
    expect(screen.getByTestId('library-detail-edit')).toBeTruthy();
    expect(screen.getByTestId('library-detail-source')).toBeTruthy();
    expect(screen.getByTestId('library-detail-star')).toBeTruthy();
    expect(screen.getByTestId('library-detail-delete')).toBeTruthy();
    expect(screen.queryByTestId('library-detail-read')).toBeNull();
  });

  it('编辑题录并保存后列表立即反映修改', async () => {
    render(<LibraryPage />);
    fireEvent.click(screen.getByRole('button', { name: /已采集的知网文献/ }));
    await waitFor(() => {
      expect(screen.getByTestId('library-detail-edit')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('library-detail-edit'));
    await waitFor(() => {
      expect(screen.getByTestId('library-edit-form')).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId('library-edit-title'), { target: { value: '修正后的文献标题' } });
    fireEvent.change(screen.getByTestId('library-edit-authors'), { target: { value: '王五；赵六' } });
    fireEvent.change(screen.getByTestId('library-edit-year'), { target: { value: '2023' } });
    fireEvent.change(screen.getByTestId('library-edit-venue'), { target: { value: '社会学研究' } });
    fireEvent.change(screen.getByTestId('library-edit-status'), { target: { value: 'read' } });
    fireEvent.click(screen.getByTestId('library-edit-save'));

    await waitFor(() => {
      expect(screen.getAllByText('修正后的文献标题').length).toBeGreaterThanOrEqual(1);
    });
    const updated = useMetisStore.getState().papers.find((p) => p.id === 'paper-existing-1')!;
    expect(updated.authors).toEqual(['王五', '赵六']);
    expect(updated.year).toBe(2023);
    expect(updated.venue).toBe('社会学研究');
    expect(updated.readStatus).toBe('read');
    expect(savePaper).toHaveBeenCalled();
  });

  it('删除需要二次确认且确认后从列表移除', async () => {
    render(<LibraryPage />);
    fireEvent.click(screen.getByRole('button', { name: /已采集的知网文献/ }));
    await waitFor(() => {
      expect(screen.getByTestId('library-detail-delete')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('library-detail-delete'));
    await waitFor(() => {
      expect(screen.getByTestId('library-delete-confirm')).toBeTruthy();
    });
    expect(screen.queryAllByTestId('library-paper-item')).toHaveLength(2);

    fireEvent.click(screen.getByTestId('library-delete-confirm'));
    await waitFor(() => {
      expect(screen.queryAllByTestId('library-paper-item')).toHaveLength(1);
    });
    expect(deletePaper).toHaveBeenCalledWith('paper-existing-1');
  });

  it('搜索过滤按标题/作者/期刊匹配', async () => {
    render(<LibraryPage />);
    expect(screen.getAllByTestId('library-paper-item')).toHaveLength(2);

    fireEvent.change(screen.getByTestId('library-filter-input'), { target: { value: 'Aubry' } });
    await waitFor(() => {
      expect(screen.getAllByTestId('library-paper-item')).toHaveLength(1);
    });
    expect(screen.getByText(/Aubry-André/)).toBeTruthy();

    fireEvent.change(screen.getByTestId('library-filter-input'), { target: { value: '不存在的关键词' } });
    await waitFor(() => {
      expect(screen.getByTestId('library-empty')).toBeTruthy();
    });
  });

  it('阅读状态筛选只显示对应条目', async () => {
    render(<LibraryPage />);
    fireEvent.change(screen.getByTestId('library-status-select'), { target: { value: 'reading' } });
    await waitFor(() => {
      expect(screen.getAllByTestId('library-paper-item')).toHaveLength(1);
    });
    expect(screen.getByText(/intermediate phases/)).toBeTruthy();
  });

  it('收藏在详情中切换并同步到列表星标', async () => {
    render(<LibraryPage />);
    fireEvent.click(screen.getByRole('button', { name: /已采集的知网文献/ }));
    await waitFor(() => {
      expect(screen.getByTestId('library-detail-star')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('library-detail-star'));
    await waitFor(() => {
      const paper = useMetisStore.getState().papers.find((p) => p.id === 'paper-existing-1')!;
      expect(paper.starred).toBe(true);
    });
  });
});

describe('LibraryPage — 项目资料模式', () => {
  beforeEach(() => {
    resetStore();
    literatureSearch.mockReset();
    savePaper.mockClear();
    linkPaperToProject.mockClear();
    browserNavigate.mockClear();
    browserShow.mockClear();
    browserHide.mockClear();
    browserListDownloads.mockClear().mockResolvedValue([]);
    window.metis = browserMetisMock();
    seedPapers([
      makePaper({ id: 'paper-proj-1', title: '属于项目的文献', projectId: 'proj-9' }),
      makePaper({ id: 'paper-other', title: '其他项目的文献', projectId: 'proj-8' }),
      makePaper({ id: 'paper-global', title: '未关联的文献' }),
    ]);
  });

  afterEach(() => {
    cleanup();
    delete (window as { metis?: unknown }).metis;
  });

  it('只显示关联到当前项目的文献', () => {
    render(<LibraryPage projectId="proj-9" />);
    const items = screen.getAllByTestId('library-paper-item');
    expect(items).toHaveLength(1);
    expect(screen.getByText('属于项目的文献')).toBeTruthy();
    expect(screen.queryByText('其他项目的文献')).toBeNull();
    expect(screen.queryByText('未关联的文献')).toBeNull();
  });

  it('项目无文献时显示项目引导空态', () => {
    render(<LibraryPage projectId="proj-empty" />);
    expect(screen.getByTestId('library-empty').textContent).toContain('这个项目还没有文献');
  });

  it('检索导入自动关联项目并写入项目资料源', async () => {
    const item = makeItem({ id: 'ncpssd:proj-import-1' });
    literatureSearch.mockResolvedValue({ ok: true, results: [item], total: 1, warnings: [] });
    render(<LibraryPage projectId="proj-9" />);

    fireEvent.change(screen.getByTestId('library-search-input'), { target: { value: '现代化' } });
    fireEvent.click(screen.getByTestId('library-search-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('library-import')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('library-import'));

    await waitFor(() => {
      expect(linkPaperToProject).toHaveBeenCalledTimes(1);
    });
    const request = linkPaperToProject.mock.calls[0]![0] as { paperId: string; projectId: string; link: boolean };
    expect(request.projectId).toBe('proj-9');
    expect(request.link).toBe(true);
  });

  it('打开原文弹出内嵌浏览浮层而非系统浏览器', async () => {
    render(<LibraryPage projectId="proj-9" />);
    fireEvent.click(screen.getByTestId('library-paper-source'));
    await waitFor(() => {
      expect(screen.getByTestId('browser-overlay')).toBeTruthy();
    });
    expect(browserNavigate).toHaveBeenCalledWith('https://kns.cnki.net/example');
    expect(browserShow).toHaveBeenCalled();
  });
});
