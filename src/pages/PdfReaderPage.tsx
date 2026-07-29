/**
 * PDF Reader Page — multi-modal PDF reading with text extraction,
 * page navigation, zoom, search, and outline (TOC) support.
 *
 * Uses pdfjs-dist for client-side PDF rendering via Canvas.
 * All colors use CSS variables for light/dark theme support.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useMetisStore } from '../store';
import { useTranslation } from '../i18n';
import { presentDiagnosticText } from '../presentation/executionPresentation';
import type { UIMode } from '../../engine/capabilities/DiagnosticMode';

// ─── Types ────────────────────────────────────────────────────

interface PageInfo {
  num: number;
  width: number;
  height: number;
}

interface SearchResult {
  pageNum: number;
  text: string;
  position: number;
}

// ─── PDF Reader Component ─────────────────────────────────────

interface PdfReaderPageProps {
  uiMode?: UIMode;
}

export default function PdfReaderPage({ uiMode = 'normal' }: PdfReaderPageProps) {
  const { papers } = useMetisStore();
  const { t } = useTranslation();

  // PDF state
  const [pdfDoc, setPdfDoc] = useState<unknown>(null);
  const [totalPages, setTotalPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [, setPageInfo] = useState<PageInfo | null>(null);
  const [zoom, setZoom] = useState(1.0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>('');

  // UI state
  const [showOutline, setShowOutline] = useState(false);
  const [outline, setOutline] = useState<Array<{ title: string; dest: unknown }>>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [currentSearchIdx, setCurrentSearchIdx] = useState(0);
  const [extractedText, setExtractedText] = useState<string>('');
  const [showText, setShowText] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<'pages' | 'outline' | 'text'>('pages');

  // Thumbnail pages for sidebar
  const [thumbnails, setThumbnails] = useState<Array<{ num: number; loaded: boolean }>>([]);

  // Refs
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pdfjsRef = useRef<unknown>(null);

  // Papers with a main-process-issued PDF capability only.
  const papersWithPdf = papers.filter((p) => p.pdfCapability);

  // ─── Load pdfjs-dist ─────────────────────────────────────

  const loadPdfjs = useCallback(async () => {
    if (pdfjsRef.current) return pdfjsRef.current;
    try {
      const pdfjs = await import('pdfjs-dist');
      // Set worker source
      const workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url,
      ).toString();
      pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
      pdfjsRef.current = pdfjs;
      return pdfjs;
    } catch {
      setError(t('pdf.errorLibraryLoadFailed'));
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Render a single page to canvas ─────────────────────

  const renderPage = useCallback(async (doc: unknown, pageNum: number, scale: number) => {
    const pdfjs = pdfjsRef.current as typeof import('pdfjs-dist') | null;
    if (!pdfjs || !canvasRef.current) return;

    const pdfDocument = doc as import('pdfjs-dist').PDFDocumentProxy;
    const page = await pdfDocument.getPage(pageNum);
    const viewport = page.getViewport({ scale });

    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    if (!context) return;

    canvas.height = viewport.height;
    canvas.width = viewport.width;

    await page.render({
      canvasContext: context,
      viewport,
    }).promise;

    setPageInfo({ num: pageNum, width: viewport.width, height: viewport.height });
  }, []);

  // ─── Load PDF from file ─────────────────────────────────

  const loadPdfFromData = useCallback(async (data: Uint8Array, name: string) => {
    setIsLoading(true);
    setError(null);
    setFileName(name);

    const pdfjs = await loadPdfjs();
    if (!pdfjs) { setIsLoading(false); return; }

    try {
      const loadingTask = (pdfjs as typeof import('pdfjs-dist')).getDocument({ data });
      const doc = await loadingTask.promise;

      setPdfDoc(doc);
      setTotalPages(doc.numPages);
      setCurrentPage(1);

      // Initialize thumbnails
      const thumbs = Array.from({ length: doc.numPages }, (_, i) => ({
        num: i + 1,
        loaded: false,
      }));
      setThumbnails(thumbs);

      // Extract outline
      try {
        const outlineData = await doc.getOutline();
        if (outlineData) {
          setOutline(outlineData.map((item: { title: string; dest: unknown }) => ({
            title: item.title ?? '',
            dest: item.dest,
          })));
        }
      } catch {
        // Outline extraction failed — non-critical
      }

      // Extract full text for search
      try {
        const textParts: string[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const textContent = await page.getTextContent();
          const pageText = textContent.items
            .map((item) => ('str' in item ? (item as { str: string }).str : ''))
            .join('');
          textParts.push(pageText);
        }
        setExtractedText(textParts.join('\n\n'));
      } catch {
        // Text extraction failed — non-critical
      }
    } catch (err) {
      setError(
        uiMode === 'diagnostic'
          ? t('pdf.errorLoadFailedDiagnostic', { error: presentDiagnosticText(String(err)) })
          : t('pdf.errorLoadFailed'),
      );
    } finally {
      setIsLoading(false);
    }
  }, [loadPdfjs, t, uiMode]);

  // The canvas is intentionally absent while loading. Render only after the
  // loading state commits and the canvas ref exists; rendering directly from
  // loadPdfFromData races that mount and leaves a permanently blank page.
  useEffect(() => {
    if (!pdfDoc || isLoading) return;
    void renderPage(pdfDoc, currentPage, zoom).catch((err: unknown) => {
      setError(
        uiMode === 'diagnostic'
          ? t('pdf.errorLoadFailedDiagnostic', { error: presentDiagnosticText(String(err)) })
          : t('pdf.errorLoadFailed'),
      );
    });
  }, [currentPage, isLoading, pdfDoc, renderPage, t, uiMode, zoom]);

  const loadPdfFromFile = useCallback(async (file: File) => {
    const arrayBuffer = await file.arrayBuffer();
    await loadPdfFromData(new Uint8Array(arrayBuffer), file.name);
  }, [loadPdfFromData]);

  // ─── Navigate pages ─────────────────────────────────────

  const goToPage = useCallback((pageNum: number) => {
    if (pageNum < 1 || pageNum > totalPages || !pdfDoc) return;
    setCurrentPage(pageNum);
  }, [pdfDoc, totalPages]);

  // ─── Zoom controls ──────────────────────────────────────

  const handleZoom = useCallback((newZoom: number) => {
    const clamped = Math.max(0.25, Math.min(4.0, newZoom));
    setZoom(clamped);
  }, []);

  // ─── Search in PDF ──────────────────────────────────────

  const handleSearch = useCallback(() => {
    if (!searchQuery.trim() || !extractedText) return;

    const query = searchQuery.toLowerCase();
    const pages = extractedText.split('\n\n');
    const results: SearchResult[] = [];

    pages.forEach((pageText, idx) => {
      let pos = pageText.toLowerCase().indexOf(query);
      while (pos !== -1) {
        const start = Math.max(0, pos - 30);
        const end = Math.min(pageText.length, pos + query.length + 30);
        results.push({
          pageNum: idx + 1,
          text: `...${pageText.slice(start, end)}...`,
          position: pos,
        });
        pos = pageText.toLowerCase().indexOf(query, pos + 1);
      }
    });

    setSearchResults(results);
    setCurrentSearchIdx(0);

    // Navigate to first result
    if (results.length > 0 && results[0]) {
      goToPage(results[0].pageNum);
    }
  }, [searchQuery, extractedText, goToPage]);

  const goToNextSearchResult = useCallback(() => {
    if (searchResults.length === 0) return;
    const nextIdx = (currentSearchIdx + 1) % searchResults.length;
    setCurrentSearchIdx(nextIdx);
    const result = searchResults[nextIdx];
    if (result) goToPage(result.pageNum);
  }, [searchResults, currentSearchIdx, goToPage]);

  // ─── Keyboard shortcuts ─────────────────────────────────

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      switch (e.key) {
        case 'ArrowLeft':
        case 'PageUp':
          e.preventDefault();
          goToPage(currentPage - 1);
          break;
        case 'ArrowRight':
        case 'PageDown':
          e.preventDefault();
          goToPage(currentPage + 1);
          break;
        case 'Home':
          e.preventDefault();
          goToPage(1);
          break;
        case 'End':
          e.preventDefault();
          goToPage(totalPages);
          break;
        case '+':
        case '=':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            handleZoom(zoom + 0.25);
          }
          break;
        case '-':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            handleZoom(zoom - 0.25);
          }
          break;
        case 'Enter':
          if (searchQuery) {
            e.preventDefault();
            goToNextSearchResult();
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentPage, totalPages, zoom, searchQuery, goToPage, handleZoom, goToNextSearchResult]);

  // ─── File input handler ─────────────────────────────────

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type === 'application/pdf') {
      loadPdfFromFile(file);
    } else if (file) {
      setError(t('pdf.errorInvalidFile'));
    }
  };

  // ─── Drop zone handler ──────────────────────────────────

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.type === 'application/pdf') {
      loadPdfFromFile(file);
    } else {
      setError(t('pdf.errorInvalidDrop'));
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleLoadFromLibrary = useCallback(async (paper: (typeof papers)[number]) => {
    try {
      const metis = window.metis;
      const capability = paper.pdfCapability;
      if (!metis?.useFileCapability || !capability) {
        setError(t('pdf.errorFileAccessUnavailable'));
        return;
      }
      const result = await metis.useFileCapability({
        capabilityId: capability.capabilityId,
        operation: 'read',
        maxBytes: 16 * 1024 * 1024,
      });
      if (!result.success || result.operation !== 'read') {
        setError(t('pdf.errorFileAccessUnavailable'));
        return;
      }
      await loadPdfFromData(new Uint8Array(result.data), paper.title);
    } catch (err) {
      setError(
        uiMode === 'diagnostic'
          ? t('pdf.errorLoadFailedDiagnostic', { error: presentDiagnosticText(String(err)) })
          : t('pdf.errorLoadFailed'),
      );
    }
  }, [loadPdfFromData, t, uiMode]);

  // ─── Render ─────────────────────────────────────────────

  // No PDF loaded — show drop zone
  if (!pdfDoc) {
    return (
      <div
        className="pdf-reader-page"
        style={{ padding: 24, height: '100%', display: 'flex', flexDirection: 'column' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0 }}>{t('pdf.pageTitle')}</h2>
          <button
            className="btn-primary"
            onClick={() => fileInputRef.current?.click()}
          >
            {t('pdf.openPdf')}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf"
            style={{ display: 'none' }}
            onChange={handleFileInput}
          />
        </div>

        {/* Drop zone */}
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          style={{
            flex: 1,
            border: '2px dashed var(--border)',
            borderRadius: 12,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-muted)',
            background: 'var(--bg-hover)',
            cursor: 'pointer',
            transition: 'border-color 0.2s',
          }}
          onClick={() => fileInputRef.current?.click()}
        >
          <svg viewBox="0 0 24 24" width="48" height="48" stroke="var(--text-muted)" fill="none" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 16 }}>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
          <h3 style={{ margin: '0 0 8px 0', color: 'var(--text-secondary)' }}>{t('pdf.dropZoneTitle')}</h3>
          <p style={{ margin: 0, color: 'var(--text-muted)' }}>{t('pdf.dropZoneSubtitle')}</p>
        </div>

        {/* Papers with PDF paths */}
        {papersWithPdf.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8 }}>{t('pdf.fromLibrary')}</h3>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {papersWithPdf.map((p) => (
                <div
                  key={p.id}
                  onClick={() => { void handleLoadFromLibrary(p); }}
                  style={{
                    padding: '8px 12px',
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    fontSize: 12,
                    cursor: 'pointer',
                    color: 'var(--text-primary)',
                  }}
                >
                  {p.title.slice(0, 40)}{p.title.length > 40 ? '...' : ''}
                </div>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div style={{ marginTop: 12, padding: '8px 12px', background: 'var(--status-failed-bg)', color: 'var(--status-failed)', borderRadius: 6, fontSize: 13 }}>
            {error}
          </div>
        )}
      </div>
    );
  }

  // PDF loaded — show reader
  return (
    <div
      className="pdf-reader-page"
      style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      {/* Toolbar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 16px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-card)',
        flexShrink: 0,
      }}>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="toolbar-btn"
        >
          {t('pdf.toolbarOpen')}
        </button>
        <input ref={fileInputRef} type="file" accept=".pdf" style={{ display: 'none' }} onChange={handleFileInput} />

        <div className="toolbar-separator" />

        {/* Page navigation */}
        <button onClick={() => goToPage(1)} disabled={currentPage <= 1} className="toolbar-btn" title="First page">
          <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 17l-5-5 5-5" /><path d="M18 17l-5-5 5-5" /></svg>
        </button>
        <button onClick={() => goToPage(currentPage - 1)} disabled={currentPage <= 1} className="toolbar-btn" title="Previous page">
          <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
        <span style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 80, textAlign: 'center' }}>
          {t('pdf.toolbarPageInfo', { current: currentPage, total: totalPages })}
        </span>
        <button onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= totalPages} className="toolbar-btn" title="Next page">
          <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
        </button>
        <button onClick={() => goToPage(totalPages)} disabled={currentPage >= totalPages} className="toolbar-btn" title="Last page">
          <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 17l5-5-5-5" /><path d="M6 17l5-5-5-5" /></svg>
        </button>

        <div className="toolbar-separator" />

        {/* Zoom controls */}
        <button onClick={() => handleZoom(zoom - 0.25)} className="toolbar-btn">
          −
        </button>
        <span style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 50, textAlign: 'center' }}>
          {Math.round(zoom * 100)}%
        </span>
        <button onClick={() => handleZoom(zoom + 0.25)} className="toolbar-btn">
          +
        </button>
        <button onClick={() => handleZoom(1.0)} className="toolbar-btn">
          {t('pdf.toolbarFit')}
        </button>

        <div className="toolbar-separator" />

        {/* Search */}
        <input
          type="text"
          placeholder={t('pdf.toolbarSearchPlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSearch(); }}
          style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid var(--border)', fontSize: 12, width: 160, background: 'var(--bg-input)', color: 'var(--text-primary)' }}
        />
        <button onClick={handleSearch} className="toolbar-btn">
          {t('pdf.toolbarFind')}
        </button>
        {searchResults.length > 0 && (
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {currentSearchIdx + 1}/{searchResults.length}
          </span>
        )}

        <div style={{ flex: 1 }} />

        {/* Sidebar toggles */}
        <button
          onClick={() => { setSidebarTab('pages'); setShowOutline(!showOutline); }}
          className={`toolbar-btn ${sidebarTab === 'pages' && showOutline ? 'active' : ''}`}
        >
          {t('pdf.toolbarPages')}
        </button>
        <button
          onClick={() => { setSidebarTab('outline'); setShowOutline(!showOutline); }}
          className={`toolbar-btn ${sidebarTab === 'outline' && showOutline ? 'active' : ''}`}
        >
          {t('pdf.toolbarOutline')}
        </button>
        <button
          onClick={() => { setSidebarTab('text'); setShowText(!showText); }}
          className={`toolbar-btn ${showText ? 'active' : ''}`}
        >
          {t('pdf.toolbarText')}
        </button>

        {/* File name */}
        <span style={{ fontSize: 11, color: 'var(--text-muted)', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {fileName}
        </span>
      </div>

      {/* Content area */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Sidebar */}
        {showOutline && (
          <div style={{
            width: 200,
            borderRight: '1px solid var(--border)',
            background: 'var(--bg-secondary)',
            overflow: 'auto',
            flexShrink: 0,
          }}>
            {sidebarTab === 'pages' && (
              <div style={{ padding: 8 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 600 }}>{t('pdf.sidebarPagesTitle')}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                  {thumbnails.map((thumb) => (
                    <div
                      key={thumb.num}
                      onClick={() => goToPage(thumb.num)}
                      style={{
                        padding: '8px 4px',
                        textAlign: 'center',
                        background: currentPage === thumb.num ? 'var(--bg-active)' : 'var(--bg-card)',
                        border: currentPage === thumb.num ? '1px solid var(--primary)' : '1px solid var(--border)',
                        borderRadius: 4,
                        cursor: 'pointer',
                        fontSize: 11,
                        color: currentPage === thumb.num ? 'var(--primary)' : 'var(--text-secondary)',
                      }}
                    >
                      {thumb.num}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {sidebarTab === 'outline' && (
              <div style={{ padding: 8 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 600 }}>{t('pdf.sidebarOutlineTitle')}</div>
                {outline.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('pdf.sidebarNoOutline')}</div>
                ) : (
                  outline.map((item, idx) => (
                    <div
                      key={idx}
                      style={{
                        padding: '6px 8px',
                        fontSize: 12,
                        color: 'var(--text-primary)',
                        cursor: 'pointer',
                        borderRadius: 4,
                        marginBottom: 2,
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      {item.title}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}

        {/* PDF Canvas */}
        <div style={{
          flex: 1,
          overflow: 'auto',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'flex-start',
          padding: 16,
          background: 'var(--bg-secondary)',
        }}>
          {isLoading ? (
            <div style={{ color: 'var(--text-secondary)', marginTop: 40 }}>Loading PDF...</div>
          ) : (
            <canvas
              ref={canvasRef}
              style={{
                boxShadow: 'var(--shadow-card)',
                background: 'var(--bg-card)',
              }}
            />
          )}
        </div>

        {/* Text extraction panel */}
        {showText && (
          <div style={{
            width: 300,
            borderLeft: '1px solid var(--border)',
            background: 'var(--bg-card)',
            overflow: 'auto',
            flexShrink: 0,
          }}>
            <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
              {t('pdf.extractedTextTitle')}
            </div>
            <div style={{ padding: 12, fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.6, whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
              {extractedText || t('pdf.extractedTextEmpty')}
            </div>
          </div>
        )}
      </div>

      {/* Search results bar */}
      {searchResults.length > 0 && (
        <div style={{
          padding: '6px 16px',
          borderTop: '1px solid var(--border)',
          background: 'var(--bg-secondary)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          flexShrink: 0,
        }}>
          <span style={{ color: 'var(--text-secondary)' }}>
            {searchResults.length} result{searchResults.length !== 1 ? 's' : ''} found
          </span>
          <button
            onClick={goToNextSearchResult}
            className="toolbar-btn"
          >
            Next
          </button>
          <span style={{ color: 'var(--text-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {searchResults[currentSearchIdx]?.text}
          </span>
          <button
            onClick={() => { setSearchResults([]); setSearchQuery(''); }}
            className="toolbar-btn" style={{ color: 'var(--status-failed)' }}
          >
            Clear
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ padding: '6px 16px', background: 'var(--status-failed-bg)', color: 'var(--status-failed)', fontSize: 12 }}>
          {error}
        </div>
      )}
    </div>
  );
}
