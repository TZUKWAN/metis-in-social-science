/**
 * 聊天 Markdown 呈现前的文本清洗（2026-09-15 拆分）。
 *
 * 从 ChatPage 随消息渲染迁出：emoji 过滤与 DOI 链接化是 settled / streaming
 * 两条渲染路径共享的源文本变换。放在 conversation 层以便宿主（handleSend
 * 的输入清洗）与渲染组件（ChatMessageList）共用，避免组件文件导出非组件
 * 值（react-refresh/only-export-components）。纯移动，行为语义不变。
 */

// ─── Emoji filter — keeps the UI free of emoji anywhere ─────────

const EMOJI_REGEX = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F100}-\u{1F1FF}\u{1F200}-\u{1F2FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2300}-\u{23FF}]/gu;

export function stripEmoji(text: string): string {
  return text.replace(EMOJI_REGEX, '').replace(/\s{2,}/g, ' ').trim();
}

function linkifyDois(content: string): string {
  // Turn bare DOIs in the model output into clickable doi.org links so the
  // message citation can be opened inside Metis.
  return content.replace(
    /(^|[^\w])10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi,
    (match, prefix: string) => {
      const doi = match.slice(prefix.length);
      return `${prefix}[${doi}](https://doi.org/${doi})`;
    },
  );
}

/** Shared source transform for both the settled and streaming render paths. */
export function transformChatMarkdown(content: string): string {
  return linkifyDois(stripEmoji(content));
}
