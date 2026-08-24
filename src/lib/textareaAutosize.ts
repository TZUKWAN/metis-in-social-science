/**
 * Grows a textarea to fit its content up to a fixed line cap, then scrolls.
 * Shared by every chat composer (converse chat, outcome assistant, scenario
 * assistant) so long instructions stay readable without shrinking the panel.
 */
export function autoResizeTextarea(el: HTMLTextAreaElement, maxLines = 10): void {
  const style = window.getComputedStyle(el);
  const fontSize = Number.parseFloat(style.fontSize) || 13;
  const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.5;
  const padY = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
  const maxHeight = Math.ceil(lineHeight * maxLines + padY);
  el.style.overflowY = 'auto';
  el.style.height = 'auto';
  const next = Math.min(el.scrollHeight, maxHeight);
  el.style.height = `${Math.max(Math.ceil(next), Math.ceil(lineHeight + padY))}px`;
}
