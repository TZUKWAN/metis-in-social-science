import { FileSpreadsheet, FileText, Image as ImageIcon, Presentation } from 'lucide-react';
import {
  type OutcomeAssistantAppliedEdit, type OutcomeAssistantChatResult,
  type OutcomeAssistantSelection as OutcomeAssistantRequestSelection,
  type OutcomeKind, type OutcomeSource, type PptDocument, type PptPage,
} from '../../../engine/runtime/OutcomeRuntimeContract';

export type AssistantSelection = { kind: 'word'; blockId: string; text: string; start?: number; end?: number; row?: number; column?: number; cross?: { endBlockId: string; endOffset: number } } | { kind: 'ppt'; pageId: string; elementId?: string } | undefined;
export type ScopedMessage = { id: string; role: 'user' | 'assistant' | 'system'; content: string; sources: OutcomeSource[]; createdAt: number };
export type ConversationUnit = { id: string; title: string; messageCount: number; createdAt: number; updatedAt: number };
export type AssistantApplied = OutcomeAssistantAppliedEdit;
export type AssistantResult = OutcomeAssistantChatResult;
export type OutcomeAssistantBridge = {
  chatOutcomeAssistant?: (request: { projectId: string; outcomeId: string; instruction: string; selection?: OutcomeAssistantRequestSelection }) => Promise<AssistantResult>;
  outcomesConversationUnits?: (request: { projectId: string; outcomeId: string }) => Promise<ConversationUnit[]>;
  outcomesConversationCreate?: (request: { projectId: string; outcomeId: string; title?: string }) => Promise<{ id: string; title: string; createdAt: number } | null>;
  outcomesConversationDelete?: (request: { projectId: string; conversationId: string }) => Promise<boolean>;
  outcomesConversationById?: (request: { projectId: string; conversationId: string }) => Promise<Array<{ id: string; role: 'user' | 'assistant' | 'system'; content: string; sources: unknown[]; createdAt: number }>>;
};

export const kindIcon = (kind: OutcomeKind) => kind === 'word' ? <FileText size={15} /> : kind === 'ppt' ? <Presentation size={15} /> : kind === 'spreadsheet' ? <FileSpreadsheet size={15} /> : kind === 'image' ? <ImageIcon size={15} /> : <FileText size={15} />;
export const asRecord = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
export const assistantBridge = (): OutcomeAssistantBridge | undefined => window.metis as unknown as OutcomeAssistantBridge | undefined;
export const requestSelection = (selection: AssistantSelection): OutcomeAssistantRequestSelection | undefined => {
  if (!selection) return undefined;
  return selection.kind === 'word'
    ? selection.row !== undefined && selection.column !== undefined
      ? { type: 'word_table_cell', blockId: selection.blockId, row: selection.row, column: selection.column, ...(selection.start !== undefined ? { start: selection.start } : {}), ...(selection.end !== undefined ? { end: selection.end } : {}) }
      : { type: 'word_block', blockId: selection.blockId, ...(selection.start !== undefined ? { start: selection.start } : {}), ...(selection.end !== undefined ? { end: selection.end } : {}) }
     : selection.elementId ? { type: 'ppt_element', pageId: selection.pageId, elementId: selection.elementId } : { type: 'ppt_page', pageId: selection.pageId };
};
// The renderer-only placeholder injected for empty decks must never reach a
// saved version or a template definition; a page counts as placeholder only
// while the user has not touched it.
export const isPristineFallbackPage = (page: PptPage): boolean => page.id === 'slide-empty' && !page.humanModified && page.elements.length === 0;
export const withoutPristineFallbackPages = (document: PptDocument): PptDocument => ({ ...document, pages: document.pages.filter((page) => !isPristineFallbackPage(page)) });
export const imageGenerationFailureNotice = (code: string): string => ({
  invalid_request: '图片生成请求无效，当前成果没有被修改。',
  image_generation_unconfigured: '图片生成尚未在设置中完成 Provider、模型或密钥配置；本次没有生成图片。',
  image_generation_provider_failed: '图片生成服务没有完成请求，当前成果没有被修改。',
  image_generation_provider_http_error: '图片生成服务返回了错误响应，当前成果没有被修改。',
  image_generation_provider_response_invalid: '图片生成服务返回的图片无效，当前成果没有被修改。',
  image_generation_media_persist_failed: '生成图片未能持久化到当前成果的媒体区，当前成果没有被修改。',
  outcome_not_found: '当前成果已不可用，图片没有被写入。',
}[code] ?? `图片生成未完成：${code}`);
