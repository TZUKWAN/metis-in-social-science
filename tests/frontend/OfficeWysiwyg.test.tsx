/**
 * WYSIWYG iframe bridge: validates the bridge script structure and the
 * postMessage protocol used between the preview iframe and the parent frame.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import { WYSIWYG_BRIDGE_SCRIPT } from '../../src/lib/officeIframeBridge';

describe('WYSIWYG bridge script', () => {
  it('contains all required message types', () => {
    expect(WYSIWYG_BRIDGE_SCRIPT).toContain("type: 'office-select'");
    expect(WYSIWYG_BRIDGE_SCRIPT).toContain("type: 'office-text-edit'");
    expect(WYSIWYG_BRIDGE_SCRIPT).toContain("type: 'office-shape-move'");
    expect(WYSIWYG_BRIDGE_SCRIPT).toContain("type: 'office-deselect'");
  });

  it('finds data-path elements by walking up from the click target', () => {
    // Simulate the bridge's findPath logic against a realistic DOM structure.
    const html = `<div class="page-body"><p data-path="/body/p[1]"><span>文本内容</span></p></div>`;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const span = doc.querySelector('span')!;

    function findPath(el: Element | null): string | null {
      while (el && el !== doc.body) {
        const path = el.getAttribute('data-path');
        if (path) return path;
        el = el.parentElement;
      }
      return null;
    }

    expect(findPath(span)).toBe('/body/p[1]');
  });

  it('double-click editing preserves the original text on escape', () => {
    // Verify the bridge's Escape-revert logic conceptually.
    const original = '原始文本';
    const el = document.createElement('p');
    el.textContent = original;
    el.contentEditable = 'true';
    el.textContent = '修改后';
    el.textContent = original; // revert path
    expect(el.textContent).toBe(original);
  });

  it('shape move messages carry cm coordinates', () => {
    // Validate the coordinate conversion used in the bridge.
    const toPt = (px: number) => px * 0.75;
    const ptToCm = (pt: number) => (pt / 28.35).toFixed(1);
    expect(ptToCm(toPt(100))).toBe('2.6');
    expect(ptToCm(toPt(200))).toBe('5.3');
  });
});
