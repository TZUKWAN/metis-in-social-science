/**
 * Outcomes（数据管理子域）IPC registrar — 从 main.ts 迁出（2026-09-15）。
 *
 * 只包含纯数据管理 handler（分类/CRUD/版本/回收站/会话/来源定位/
 * 生成技能持久化）。METIS OFFICE 链路（word/docx/pptx/ppt/外部编辑器/
 * image/assistant/template/formatting/media）与清理调用方一律留在
 * main.ts 原位，保持稳定不动。
 */

import { OutcomeCategoryCreateSchema, OutcomeCategoryDeleteSchema, OutcomeCategoryRenameSchema, OutcomeFinalRequestSchema, OutcomeGetRequestSchema, OutcomeListRequestSchema, OutcomeMoveRequestSchema, OutcomeRenameRequestSchema, OutcomeRestoreRequestSchema, OutcomeSourceLocateRequestSchema, OutcomeSourceLocateResultSchema, OutcomeTrashListRequestSchema, OutcomeTrashRequestSchema, OutcomeVersionsRequestSchema, PptGenerationSkillSaveRequestSchema, PptGenerationSkillSchema, ScopedConversationAppendToSchema, ScopedConversationCreateSchema, ScopedConversationMessageRequestSchema, ScopedConversationRefSchema, ScopedConversationRequestSchema } from '../../engine/runtime/OutcomeRuntimeContract.js';
import { randomUUID } from 'node:crypto';
import type { DomainIpcContext } from './DomainIpcContext.js';

export function registerOutcomeDataIpc(ctx: DomainIpcContext): () => void {
  const { purgeExpiredOutcomeTrash } = ctx;
  const dom = ctx.registry.domain('outcome-data', ['outcomes:']);

  dom.handle('outcomes:categories:list', (event) => { try { ctx.requireRendererMainFrame(event); return ctx.outcomeRepository()?.listCategories() ?? []; } catch { return []; } });
  dom.handle('outcomes:categories:create', (event, raw: unknown) => { try { ctx.requireRendererMainFrame(event); const p=OutcomeCategoryCreateSchema.safeParse(raw); return p.success && ctx.outcomeRepository() ? ctx.outcomeRepository()!.createCategory(p.data.name) : null; } catch { return null; } });
  dom.handle('outcomes:categories:rename', (event, raw: unknown) => { try { ctx.requireRendererMainFrame(event); const p=OutcomeCategoryRenameSchema.safeParse(raw); return p.success && ctx.outcomeRepository() ? ctx.outcomeRepository()!.renameCategory(p.data.categoryId,p.data.name) ?? null : null; } catch { return null; } });
  dom.handle('outcomes:categories:delete', (event, raw: unknown) => { try { ctx.requireRendererMainFrame(event); const p=OutcomeCategoryDeleteSchema.safeParse(raw); return Boolean(p.success && ctx.outcomeRepository()?.deleteCategory(p.data.categoryId)); } catch { return false; } });
  dom.handle('outcomes:list', async (event, raw: unknown) => { try { ctx.requireRendererMainFrame(event); const p=OutcomeListRequestSchema.safeParse(raw); if (!p.success || !ctx.outcomeRepository()) return []; await purgeExpiredOutcomeTrash(); return ctx.outcomeRepository()!.list(p.data.projectId,p.data.query); } catch { return []; } });
  dom.handle('outcomes:get', (event, raw: unknown) => { try { ctx.requireRendererMainFrame(event); const p=OutcomeGetRequestSchema.safeParse(raw); return p.success && ctx.outcomeRepository() ? ctx.outcomeRepository()!.get(p.data.projectId,p.data.outcomeId,p.data.version) ?? null : null; } catch { return null; } });
  dom.handle('outcomes:versions', (event, raw: unknown) => { try { ctx.requireRendererMainFrame(event); const p=OutcomeVersionsRequestSchema.safeParse(raw); return p.success && ctx.outcomeRepository() ? ctx.outcomeRepository()!.versions(p.data.projectId,p.data.outcomeId) : []; } catch { return []; } });
  dom.handle('outcomes:restore', (event, raw: unknown) => { try { ctx.requireRendererMainFrame(event); const p=OutcomeRestoreRequestSchema.safeParse(raw); return p.success && ctx.outcomeRepository() ? ctx.outcomeRepository()!.restore(p.data.projectId,p.data.outcomeId,p.data.version,p.data.note) : null; } catch { return null; } });
  dom.handle('outcomes:rename', (event, raw: unknown) => { try { ctx.requireRendererMainFrame(event); const p=OutcomeRenameRequestSchema.safeParse(raw); return p.success && ctx.outcomeRepository() ? ctx.outcomeRepository()!.rename(p.data.projectId,p.data.outcomeId,p.data.title) ?? null : null; } catch { return null; } });
  dom.handle('outcomes:move', (event, raw: unknown) => { try { ctx.requireRendererMainFrame(event); const p=OutcomeMoveRequestSchema.safeParse(raw); return p.success && ctx.outcomeRepository() ? ctx.outcomeRepository()!.move(p.data.projectId,p.data.outcomeId,p.data.categoryId) ?? null : null; } catch { return null; } });
  dom.handle('outcomes:markFinal', (event, raw: unknown) => { try { ctx.requireRendererMainFrame(event); const p=OutcomeFinalRequestSchema.safeParse(raw); return p.success && ctx.outcomeRepository() ? ctx.outcomeRepository()!.markFinal(p.data.projectId,p.data.outcomeId,p.data.version) ?? null : null; } catch { return null; } });
  dom.handle('outcomes:trash:list', async (event, raw: unknown) => { try { ctx.requireRendererMainFrame(event); const p=OutcomeTrashListRequestSchema.safeParse(raw); if (!p.success || !ctx.outcomeRepository()) return []; await purgeExpiredOutcomeTrash(); return ctx.outcomeRepository()!.listArchived(p.data.projectId); } catch { return []; } });
  dom.handle('outcomes:trash:restore', (event, raw: unknown) => { try { ctx.requireRendererMainFrame(event); const p=OutcomeTrashRequestSchema.safeParse(raw); return p.success && ctx.outcomeRepository() ? ctx.outcomeRepository()!.restoreArchived(p.data.projectId,p.data.outcomeId) : false; } catch { return false; } });
  dom.handle('outcomes:conversation:list', (event, raw: unknown) => { try { ctx.requireRendererMainFrame(event); const p=ScopedConversationRequestSchema.safeParse(raw); return p.success && ctx.outcomeRepository() ? ctx.outcomeRepository()!.listConversation(p.data) : []; } catch { return []; } });
  dom.handle('outcomes:conversation:append', (event, raw: unknown) => { try { ctx.requireRendererMainFrame(event); const p=ScopedConversationMessageRequestSchema.safeParse(raw); return p.success && ctx.outcomeRepository() ? ctx.outcomeRepository()!.appendConversation(p.data) : null; } catch { return null; } });
  dom.handle('outcomes:conversation:units', (event, raw: unknown) => { try { ctx.requireRendererMainFrame(event); const p=ScopedConversationRequestSchema.safeParse(raw); return p.success && ctx.outcomeRepository() ? ctx.outcomeRepository()!.listConversations(p.data) : []; } catch { return []; } });
  dom.handle('outcomes:conversation:create', (event, raw: unknown) => { try { ctx.requireRendererMainFrame(event); const p=ScopedConversationCreateSchema.safeParse(raw); return p.success && ctx.outcomeRepository() ? ctx.outcomeRepository()!.createConversation({ ...p.data, scope: 'outcome' }) : null; } catch { return null; } });
  dom.handle('outcomes:conversation:delete', (event, raw: unknown) => { try { ctx.requireRendererMainFrame(event); const p=ScopedConversationRefSchema.safeParse(raw); return p.success && ctx.outcomeRepository() ? ctx.outcomeRepository()!.deleteConversation(p.data) : false; } catch { return false; } });
  dom.handle('outcomes:conversation:byId', (event, raw: unknown) => { try { ctx.requireRendererMainFrame(event); const p=ScopedConversationRefSchema.safeParse(raw); return p.success && ctx.outcomeRepository() ? ctx.outcomeRepository()!.listMessagesByConversation(p.data) : []; } catch { return []; } });
  dom.handle('outcomes:conversation:appendTo', (event, raw: unknown) => { try { ctx.requireRendererMainFrame(event); const p=ScopedConversationAppendToSchema.safeParse(raw); return p.success && ctx.outcomeRepository() ? ctx.outcomeRepository()!.appendToConversation(p.data) : null; } catch { return null; } });
  dom.handle('outcomes:source:locate', (event, raw: unknown) => {
    try { ctx.requireRendererMainFrame(event); } catch {
      return OutcomeSourceLocateResultSchema.parse({ ok: false, code: 'invalid_request' });
    }
    const parsed = OutcomeSourceLocateRequestSchema.safeParse(raw);
    if (!parsed.success || !ctx.outcomeRepository()) {
      return OutcomeSourceLocateResultSchema.parse({ ok: false, code: 'invalid_request' });
    }
    try {
      return ctx.outcomeRepository()!.locateSource({ projectId: parsed.data.projectId, source: parsed.data.source });
    } catch {
      return OutcomeSourceLocateResultSchema.parse({ ok: false, code: 'source_not_found' });
    }
  });
  dom.handle('outcomes:generation-skill:save',(event,raw:unknown)=>{try{ctx.requireRendererMainFrame(event);const p=PptGenerationSkillSaveRequestSchema.safeParse(raw);if(!p.success||!ctx.store())return null;const now=Date.now();const value=PptGenerationSkillSchema.parse({id:'ppt-skill-'+randomUUID(),...p.data});ctx.store()!.raw.prepare('INSERT INTO outcome_templates (id,name,kind,definition_json,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(value.id,value.name,'ppt_generation_skill',JSON.stringify(value),now,now);return value;}catch{return null;}});
  dom.handle('outcomes:generation-skill:list',(event)=>{try{ctx.requireRendererMainFrame(event);return (ctx.store()?.raw.prepare("SELECT definition_json FROM outcome_templates WHERE kind = 'ppt_generation_skill' ORDER BY updated_at DESC").all() as Array<{definition_json:string}>??[]).flatMap(row=>{try{const p=PptGenerationSkillSchema.safeParse(JSON.parse(row.definition_json));return p.success?[p.data]:[];}catch{return[];}});}catch{return[];}});

  return () => dom.dispose();
}
