import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { ARTIFACT_PROMPT_DEFINITIONS, getArtifactPromptDefinition } from '../engine/artifacts/prompts/ArtifactPromptRegistry.js';
import { OFFICE_CAPABILITY_DEFINITIONS, OFFICE_SLOT_TO_BASE_PROMPT, getOfficeCapability } from '../engine/artifacts/prompts/OfficeCapabilityRegistry.js';

/**
 * METIS Office Prompt Profile 服务(2026-09-05 刘总要求,任务5)。
 *
 * 每种 Office 格式支持任意数量 Profile;一个 Profile = 该格式全部真实 slot 的一套内容。
 * 内置(builtin)Profile 可直接编辑;删除走软删除(tombstone),升级不复活。
 * 解析优先级:Outcome 显式绑定 → 格式默认 Profile → 内置 Profile slot → 通用 Registry default。
 * 全删光时仍有 internal fallback(通用 Registry default),AI 永不因缺 Profile 崩溃。
 */

export interface OfficePromptProfile {
  id: string;
  officeKind: string;
  name: string;
  description: string;
  builtin: boolean;
  slots: Record<string, string>;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

const MAX_SLOT_CHARS = 20_000;

function builtinProfileSpec(kind: string): { name: string; description: string; slots: Record<string, string> } | null {
  const capability = OFFICE_CAPABILITY_DEFINITIONS.find((definition) => definition.kind === kind);
  if (!capability || !capability.aiEnabled) return null;
  const slots: Record<string, string> = {};
  for (const action of capability.aiActions) {
    const baseId = OFFICE_SLOT_TO_BASE_PROMPT[action.slotId];
    const baseDefinition = baseId ? getArtifactPromptDefinition(baseId) : undefined;
    slots[action.slotId] = baseDefinition?.defaultPrompt ?? '';
  }
  return {
    name: `${capability.label} · 通用默认`,
    description: 'METIS 出厂默认工作方式;可直接编辑,恢复随时可用。',
    slots,
  };
}

export class OfficePromptProfileService {
  constructor(private readonly db: Database) {}

  /** 启动种子:每个 aiEnabled 格式确保有一个内置通用 Profile(幂等)。 */
  ensureBuiltinProfiles(): void {
    for (const definition of OFFICE_CAPABILITY_DEFINITIONS) {
      const spec = builtinProfileSpec(definition.kind);
      if (!spec) continue;
      const existing = this.db.prepare(
        'SELECT id FROM office_prompt_profiles WHERE office_kind = ? AND builtin = 1 AND deleted_at IS NULL',
      ).get(definition.kind) as { id: string } | undefined;
      if (existing) continue;
      const now = Date.now();
      this.db.prepare(
        'INSERT INTO office_prompt_profiles (id, office_kind, name, description, builtin, slots_json, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, NULL, ?, ?)',
      ).run(`office_${definition.kind}_default`, definition.kind, spec.name, spec.description, JSON.stringify(spec.slots), now, now);
    }
  }

  listProfiles(officeKind: string): OfficePromptProfile[] {
    const rows = this.db.prepare(
      'SELECT * FROM office_prompt_profiles WHERE office_kind = ? AND deleted_at IS NULL ORDER BY builtin DESC, updated_at DESC',
    ).all(officeKind) as Array<Record<string, unknown>>;
    return rows.map((row) => this.decodeProfile(row)).filter((item): item is OfficePromptProfile => item !== null);
  }

  getProfile(profileId: string): OfficePromptProfile | null {
    const row = this.db.prepare('SELECT * FROM office_prompt_profiles WHERE id = ? AND deleted_at IS NULL').get(profileId) as Record<string, unknown> | undefined;
    return row ? this.decodeProfile(row) : null;
  }

  private decodeProfile(row: Record<string, unknown>): OfficePromptProfile | null {
    let slots: Record<string, string> = {};
    try {
      const parsed = JSON.parse((row.slots_json as string) || '{}') as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') slots[key] = value;
      }
    } catch { slots = {}; }
    return {
      id: row.id as string,
      officeKind: row.office_kind as string,
      name: row.name as string,
      description: row.description as string,
      builtin: row.builtin === 1,
      slots,
      deletedAt: (row.deleted_at as number | null) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  createProfile(input: { officeKind: string; name: string; description?: string; fromProfileId?: string }): { ok: true; profile: OfficePromptProfile } | { ok: false; code: string } {
    const capability = getOfficeCapability(input.officeKind);
    if (!capability) return { ok: false, code: 'unknown_office_kind' };
    const name = input.name.trim() || '未命名 Profile';
    let slots: Record<string, string> = {};
    if (input.fromProfileId) {
      const source = this.getProfile(input.fromProfileId);
      if (!source || source.officeKind !== input.officeKind) return { ok: false, code: 'source_profile_not_found' };
      slots = { ...source.slots };
    } else {
      const builtin = this.listProfiles(input.officeKind).find((profile) => profile.builtin);
      slots = builtin ? { ...builtin.slots } : {};
    }
    const now = Date.now();
    const profile: OfficePromptProfile = {
      id: `office_profile_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      officeKind: input.officeKind,
      name: name.slice(0, 120),
      description: (input.description ?? '').slice(0, 500),
      builtin: false,
      slots,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(
      'INSERT INTO office_prompt_profiles (id, office_kind, name, description, builtin, slots_json, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, NULL, ?, ?)',
    ).run(profile.id, profile.officeKind, profile.name, profile.description, JSON.stringify(profile.slots), profile.createdAt, profile.updatedAt);
    return { ok: true, profile };
  }

  updateProfile(profileId: string, patch: { name?: string; description?: string }): OfficePromptProfile | null {
    const profile = this.getProfile(profileId);
    if (!profile) return null;
    const next = {
      ...profile,
      name: (patch.name ?? profile.name).slice(0, 120),
      description: (patch.description ?? profile.description).slice(0, 500),
      updatedAt: Date.now(),
    };
    this.db.prepare('UPDATE office_prompt_profiles SET name = ?, description = ?, updated_at = ? WHERE id = ?')
      .run(next.name, next.description, next.updatedAt, profileId);
    return next;
  }

  /** 软删除(tombstone);内置与用户 Profile 同规则,可恢复。 */
  deleteProfile(profileId: string): boolean {
    const profile = this.getProfile(profileId);
    if (!profile) return false;
    this.db.prepare('UPDATE office_prompt_profiles SET deleted_at = ?, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), profileId);
    this.db.prepare('DELETE FROM office_prompt_profile_defaults WHERE profile_id = ?').run(profileId);
    this.db.prepare('DELETE FROM office_prompt_outcome_bindings WHERE profile_id = ?').run(profileId);
    return true;
  }

  restoreProfile(profileId: string): OfficePromptProfile | null {
    const row = this.db.prepare('SELECT * FROM office_prompt_profiles WHERE id = ? AND deleted_at IS NOT NULL').get(profileId) as Record<string, unknown> | undefined;
    if (!row) return null;
    this.db.prepare('UPDATE office_prompt_profiles SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(Date.now(), profileId);
    return this.getProfile(profileId);
  }

  listDeletedProfiles(officeKind: string): OfficePromptProfile[] {
    const rows = this.db.prepare('SELECT * FROM office_prompt_profiles WHERE office_kind = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC').all(officeKind) as Array<Record<string, unknown>>;
    return rows.map((row) => this.decodeProfile(row)).filter((item): item is OfficePromptProfile => item !== null);
  }

  /** 编辑 slot:写 profile + revision;空内容=回到该 slot 的回退值(删除覆盖)。 */
  setSlot(profileId: string, slotId: string, content: string, source: 'manual' | 'assistant' | 'import' = 'manual'): { ok: true; profile: OfficePromptProfile } | { ok: false; code: string } {
    const profile = this.getProfile(profileId);
    if (!profile) return { ok: false, code: 'profile_not_found' };
    const capability = getOfficeCapability(profile.officeKind);
    if (!capability?.aiActions.some((action) => action.slotId === slotId)) return { ok: false, code: 'unknown_slot' };
    if (content.length > MAX_SLOT_CHARS) return { ok: false, code: 'invalid_content' };
    const nextSlots = { ...profile.slots };
    if (content.trim()) nextSlots[slotId] = content;
    else delete nextSlots[slotId];
    const now = Date.now();
    this.db.prepare('UPDATE office_prompt_profiles SET slots_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(nextSlots), now, profileId);
    this.db.prepare(
      'INSERT INTO office_prompt_profile_revisions (id, profile_id, slot_id, content, created_at, source) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(`orev_${randomUUID().replace(/-/g, '').slice(0, 16)}`, profileId, slotId, content, now, source);
    return { ok: true, profile: this.getProfile(profileId)! };
  }

  // ── 默认 Profile(每格式一个)──

  setDefaultProfile(officeKind: string, profileId: string): { ok: true } | { ok: false; code: string } {
    const profile = this.getProfile(profileId);
    if (!profile || profile.officeKind !== officeKind) return { ok: false, code: 'profile_not_found' };
    this.db.prepare(
      'INSERT INTO office_prompt_profile_defaults (office_kind, profile_id) VALUES (?, ?) ON CONFLICT(office_kind) DO UPDATE SET profile_id = excluded.profile_id',
    ).run(officeKind, profileId);
    return { ok: true };
  }

  getDefaultProfileId(officeKind: string): string | null {
    const row = this.db.prepare('SELECT profile_id FROM office_prompt_profile_defaults WHERE office_kind = ?').get(officeKind) as { profile_id: string } | undefined;
    return row?.profile_id ?? null;
  }

  // ── Outcome 显式绑定 ──

  bindOutcome(outcomeId: string, profileId: string): { ok: true } | { ok: false; code: string } {
    const profile = this.getProfile(profileId);
    if (!profile) return { ok: false, code: 'profile_not_found' };
    this.db.prepare(
      'INSERT INTO office_prompt_outcome_bindings (outcome_id, profile_id) VALUES (?, ?) ON CONFLICT(outcome_id) DO UPDATE SET profile_id = excluded.profile_id',
    ).run(outcomeId, profileId);
    return { ok: true };
  }

  unbindOutcome(outcomeId: string): void {
    this.db.prepare('DELETE FROM office_prompt_outcome_bindings WHERE outcome_id = ?').run(outcomeId);
  }

  getOutcomeBinding(outcomeId: string): string | null {
    const row = this.db.prepare('SELECT profile_id FROM office_prompt_outcome_bindings WHERE outcome_id = ?').get(outcomeId) as { profile_id: string } | undefined;
    return row?.profile_id ?? null;
  }

  /**
   * 统一解析入口:Outcome 显式绑定 → 格式默认 Profile → 内置 Profile → 通用 Registry。
   * 返回 null 表示该 slot 无覆盖,使用任务4 Registry 的 defaultPrompt(内部 fallback)。
   */
  resolveSlot(officeKind: string, outcomeId: string | null, slotId: string): string | null {
    const baseId = OFFICE_SLOT_TO_BASE_PROMPT[slotId];
    const tryProfile = (profileId: string | null): string | null => {
      if (!profileId) return null;
      const profile = this.getProfile(profileId);
      if (!profile || profile.officeKind !== officeKind) return null;
      return profile.slots[slotId] ?? null;
    };
    if (outcomeId) {
      const bound = tryProfile(this.getOutcomeBinding(outcomeId));
      if (bound !== null) return bound;
    }
    const defaultId = tryProfile(this.getDefaultProfileId(officeKind));
    if (defaultId !== null) return defaultId;
    const builtin = this.listProfiles(officeKind).find((profile) => profile.builtin);
    if (builtin) {
      const content = builtin.slots[slotId];
      if (content !== undefined && content.trim()) return content;
    }
    if (baseId) {
      const baseDefinition = getArtifactPromptDefinition(baseId);
      if (baseDefinition) return null;
    }
    return null;
  }

  /**
   * 以通用 Registry promptId(outcome.assistant / presentation.generation 等)解析
   * Office Profile 覆盖;officeKind 已知时直接定位,未知则按 slot 映射反查全部 kind。
   */
  resolveForBasePrompt(basePromptId: string, outcomeId: string | null, officeKind?: string): string | null {
    const kindCandidates: string[] = [];
    if (officeKind) {
      kindCandidates.push(officeKind);
    } else {
      for (const [slotId, base] of Object.entries(OFFICE_SLOT_TO_BASE_PROMPT)) {
        if (base !== basePromptId) continue;
        for (const definition of OFFICE_CAPABILITY_DEFINITIONS) {
          if (definition.aiActions.some((action) => action.slotId === slotId)) kindCandidates.push(definition.kind);
        }
      }
    }
    for (const kind of kindCandidates) {
      const capability = getOfficeCapability(kind);
      if (!capability) continue;
      for (const action of capability.aiActions) {
        if (OFFICE_SLOT_TO_BASE_PROMPT[action.slotId] !== basePromptId) continue;
        const content = this.resolveSlot(kind, outcomeId, action.slotId);
        if (content !== null && content.trim()) return content;
      }
    }
    return null;
  }

  listCapabilitySummaries(): Array<{ kind: string; label: string; profileCount: number; defaultProfileId: string | null; aiEnabled: boolean }> {
    return OFFICE_CAPABILITY_DEFINITIONS.map((definition) => ({
      kind: definition.kind,
      label: definition.label,
      profileCount: this.listProfiles(definition.kind).length,
      defaultProfileId: this.getDefaultProfileId(definition.kind),
      aiEnabled: definition.aiEnabled,
    }));
  }
}

// office_prompt_profile_defaults 表在 schema v17 追加(与 profiles 同批)。
declare module 'better-sqlite3' {}
export const OFFICE_PROMPT_DEFAULTS_TABLE_SQL = 'CREATE TABLE IF NOT EXISTS office_prompt_profile_defaults (office_kind TEXT PRIMARY KEY, profile_id TEXT NOT NULL);';
export const OFFICE_PROMPT_OUTCOME_BINDINGS_TABLE_SQL = 'CREATE TABLE IF NOT EXISTS office_prompt_outcome_bindings (outcome_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL);';
export const OFFICE_CAPABILITY_COUNT = OFFICE_CAPABILITY_DEFINITIONS.length;
