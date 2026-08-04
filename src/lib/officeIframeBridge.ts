/**
 * Inject into the Office preview iframe to enable WYSIWYG interaction:
 * click to select an element (highlight), double-click to edit its text
 * inline. The parent frame listens for messages and drives officecli via IPC.
 *
 * This script runs inside the iframe's own context (sandboxed, no parent
 * access) — it communicates via postMessage only.
 */

export const WYSIWYG_BRIDGE_SCRIPT = `
(function() {
  'use strict';

  var selectedPath = null;
  var selectedEl = null;

  function highlight(el) {
    if (selectedEl) selectedEl.style.outline = '';
    selectedEl = el;
    selectedEl.style.outline = '2px solid #4a6fa5';
    selectedEl.style.outlineOffset = '1px';
  }

  function clearHighlight() {
    if (selectedEl) selectedEl.style.outline = '';
    selectedEl = null;
  }

  function findPath(el) {
    while (el && el !== document.body) {
      var path = el.getAttribute && el.getAttribute('data-path');
      if (path) return { path: path, el: el };
      el = el.parentElement;
    }
    return null;
  }

  // Click: select element and notify parent.
  document.addEventListener('click', function(e) {
    var hit = findPath(e.target);
    if (!hit) { clearHighlight(); return; }
    e.preventDefault();
    e.stopPropagation();
    selectedPath = hit.path;
    highlight(hit.el);
    parent.postMessage({
      type: 'office-select',
      path: hit.path,
      text: hit.el.textContent || '',
      tag: hit.el.tagName.toLowerCase()
    }, '*');
  }, true);

  // Double-click: enter inline edit mode.
  document.addEventListener('dblclick', function(e) {
    var hit = findPath(e.target);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    var el = hit.el;
    var path = hit.path;
    // Make editable and let the user type.
    el.contentEditable = 'true';
    el.style.background = 'rgba(74,111,165,0.08)';
    el.style.minHeight = '1em';
    el.focus();
    // Select all text for quick replacement.
    var range = document.createRange();
    range.selectNodeContents(el);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    function finish() {
      el.contentEditable = 'false';
      el.style.background = '';
      var newText = el.textContent || '';
      parent.postMessage({
        type: 'office-text-edit',
        path: path,
        text: newText
      }, '*');
      el.removeEventListener('blur', finish);
      el.removeEventListener('keydown', onKey);
    }
    function onKey(e2) {
      if (e2.key === 'Enter' && !e2.shiftKey) {
        e2.preventDefault();
        finish();
      }
      if (e2.key === 'Escape') {
        e2.preventDefault();
        el.textContent = hit.el.textContent; // revert
        el.contentEditable = 'false';
        el.style.background = '';
        el.removeEventListener('blur', finish);
        el.removeEventListener('keydown', onKey);
      }
    }
    el.addEventListener('blur', finish);
    el.addEventListener('keydown', onKey);
  }, true);

  // ── Drag-and-drop for PPT shapes ──────────────────────────────
  var dragState = null;

  function findShape(el) {
    while (el && el !== document.body) {
      var path = el.getAttribute && el.getAttribute('data-path');
      if (path && path.includes('shape')) return { path: path, el: el };
      el = el.parentElement;
    }
    return null;
  }

  function toPt(px) { return px * 0.75; } // 1px = 0.75pt (96dpi)
  function ptToCm(pt) { return (pt / 28.35).toFixed(1); }

  document.addEventListener('mousedown', function(e) {
    var hit = findShape(e.target);
    if (!hit) return;
    e.preventDefault();
    var rect = hit.el.getBoundingClientRect();
    dragState = {
      el: hit.el,
      path: hit.path,
      startX: e.clientX,
      startY: e.clientY,
      origX: rect.left,
      origY: rect.top,
      origW: rect.width,
      origH: rect.height,
    };
    hit.el.style.cursor = 'move';
  }, true);

  document.addEventListener('mousemove', function(e) {
    if (!dragState) return;
    e.preventDefault();
    var dx = e.clientX - dragState.startX;
    var dy = e.clientY - dragState.startY;
    dragState.el.style.position = 'relative';
    dragState.el.style.left = dx + 'px';
    dragState.el.style.top = dy + 'px';
    dragState.el.style.zIndex = '10';
    dragState.el.style.opacity = '0.85';
  }, true);

  document.addEventListener('mouseup', function(e) {
    if (!dragState) return;
    e.preventDefault();
    var el = dragState.el;
    var dx = e.clientX - dragState.startX;
    var dy = e.clientY - dragState.startY;
    // Only commit if actually moved (not just a click).
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      var newXPt = toPt(dragState.origX + dx);
      var newYPt = toPt(dragState.origY + dy);
      parent.postMessage({
        type: 'office-shape-move',
        path: dragState.path,
        x: ptToCm(newXPt) + 'cm',
        y: ptToCm(newYPt) + 'cm'
      }, '*');
    }
    el.style.position = '';
    el.style.left = '';
    el.style.top = '';
    el.style.zIndex = '';
    el.style.opacity = '';
    el.style.cursor = '';
    dragState = null;
  }, true);

  // Notify parent of clicks on empty areas (deselect).
  document.addEventListener('click', function(e) {
    if (!findPath(e.target)) {
      clearHighlight();
      selectedPath = null;
      parent.postMessage({ type: 'office-deselect' }, '*');
    }
  }, false);
})();
`;

export interface OfficeSelectMessage {
  type: 'office-select';
  path: string;
  text: string;
  tag: string;
}

export interface OfficeTextEditMessage {
  type: 'office-text-edit';
  path: string;
  text: string;
}

export interface OfficeDeselectMessage {
  type: 'office-deselect';
}

export interface OfficeShapeMoveMessage {
  type: 'office-shape-move';
  path: string;
  x: string;
  y: string;
}

export type OfficeIframeMessage = OfficeSelectMessage | OfficeTextEditMessage | OfficeDeselectMessage | OfficeShapeMoveMessage;
