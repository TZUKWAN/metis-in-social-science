/**
 * Memory Manager — 本地记忆系统
 *
 * 三层记忆：
 *  1. Project Memory: 用户可编辑的项目级记忆（CLAUDE_MEMORY.md）
 *  2. Conversation Summary: 长对话自动摘要，存入 SQLite
 *  3. Cross-Session Memory: 关键决策、用户偏好，存入 SQLite memory 表
 */

import fs from 'node:fs';
import path from 'node:path';
import type { PersistenceStore } from '../persistence/PersistenceStore.js';

export interface MemoryEntry {
  key: string;
  value: string;
  category: string;
  createdAt: number;
  updatedAt: number;
}

export class MemoryManager {
  private readonly store: PersistenceStore;
  private readonly projectMemoryPath: string;

  constructor(store: PersistenceStore, dataDir: string) {
    this.store = store;
    this.projectMemoryPath = path.join(dataDir, 'CLAUDE_MEMORY.md');
  }

  // ─── Project Memory ─────────────────────────────────────────

  loadProjectMemory(): string {
    try {
      if (fs.existsSync(this.projectMemoryPath)) {
        return fs.readFileSync(this.projectMemoryPath, 'utf-8');
      }
    } catch { /* ignore */ }
    return '';
  }

  saveProjectMemory(content: string): void {
    try {
      fs.writeFileSync(this.projectMemoryPath, content, 'utf-8');
    } catch { /* ignore */ }
  }

  // ─── Conversation Summary ───────────────────────────────────

  getConversationSummary(sessionId: string): string {
    const entry = this.store.getMemory(`summary:${sessionId}`);
    return entry?.value ?? '';
  }

  saveConversationSummary(sessionId: string, summary: string): void {
    this.store.setMemory(`summary:${sessionId}`, summary, 'conversation_summary');
  }

  // ─── Cross-Session Memory (METIS-F12: optional projectId scoping) ──

  recordKeyDecision(decision: string, context?: string, projectId?: string): void {
    const now = Date.now();
    const key = `decision:${now}`;
    const value = context ? `${decision}\n\nContext: ${context}` : decision;
    if (projectId) {
      this.store.setMemoryScoped(projectId, key, value, 'key_decision');
    } else {
      this.store.setMemory(key, value, 'key_decision');
    }
  }

  getKeyDecisions(limit = 20, projectId?: string): MemoryEntry[] {
    return this.store.getMemoryByCategory('key_decision', projectId).slice(0, limit);
  }

  recordPreference(key: string, value: string, projectId?: string): void {
    if (projectId) {
      this.store.setMemoryScoped(projectId, `pref:${key}`, value, 'preference');
    } else {
      this.store.setMemory(`pref:${key}`, value, 'preference');
    }
  }

  getPreference(key: string, projectId?: string): string | undefined {
    return projectId
      ? this.store.getMemoryScoped(projectId, `pref:${key}`)?.value
      : this.store.getMemory(`pref:${key}`)?.value;
  }

  getAllPreferences(projectId?: string): MemoryEntry[] {
    return this.store.getMemoryByCategory('preference', projectId);
  }

  // ─── General Memory ─────────────────────────────────────────

  set(key: string, value: string, category = 'general', projectId?: string): void {
    if (projectId) {
      this.store.setMemoryScoped(projectId, key, value, category);
    } else {
      this.store.setMemory(key, value, category);
    }
  }

  get(key: string, projectId?: string): string | undefined {
    return projectId
      ? this.store.getMemoryScoped(projectId, key)?.value
      : this.store.getMemory(key)?.value;
  }

  getByCategory(category: string, projectId?: string): MemoryEntry[] {
    return this.store.getMemoryByCategory(category, projectId);
  }

  delete(key: string, projectId?: string): void {
    if (projectId) {
      this.store.deleteMemoryScoped(projectId, key);
    } else {
      this.store.deleteMemory(key);
    }
  }

  // ─── Context Injection ──────────────────────────────────────

  /**
   * 构建注入 AgentLoop system prompt 的记忆上下文。
   * 包含 project memory + 最近的关键决策 + 用户偏好。
   *
   * METIS-F12: pass a projectId to restrict injection to that project's memories
   * (global memories remain included for backward compatibility).
   *
   * STATUS: WIRED.
   * The Electron main process appends this context to the skillPrompt /
   * resolvedSystemPrompt before each chat turn, so recorded key decisions,
   * project memory, and user preferences now flow back into the agent. The
   * scenario runtime additionally builds its own per-step context
   * (ScenarioWorkflowService.scenarioMemoryContext).
   */
  buildMemoryContext(projectId?: string): string {
    const parts: string[] = [];

    const projectMemory = this.loadProjectMemory();
    if (projectMemory.trim()) {
      parts.push('## Project Memory\n' + projectMemory.trim());
    }

    // METIS-F12: within a project, inject that project's memories plus global ones
    // (legacy rows carry no project); outside any project, global memories only.
    const mergeScopedAndGlobal = (
      category: string,
      limit: number,
      sortDesc: (a: MemoryEntry, b: MemoryEntry) => number,
    ): MemoryEntry[] => {
      const scoped = projectId ? this.store.getMemoryByCategory(category, projectId) : [];
      const global = this.store.getMemoryByCategory(category);
      return [...scoped, ...global].sort(sortDesc).slice(0, limit);
    };
    const byUpdatedDesc = (a: MemoryEntry, b: MemoryEntry) => b.updatedAt - a.updatedAt;

    const decisions = mergeScopedAndGlobal('key_decision', 10, byUpdatedDesc);
    if (decisions.length > 0) {
      parts.push(
        '## Recent Key Decisions\n' +
        decisions.map((d) => `- ${new Date(d.updatedAt).toLocaleDateString()}: ${d.value}`).join('\n')
      );
    }

    const prefs = mergeScopedAndGlobal('preference', 50, byUpdatedDesc);
    if (prefs.length > 0) {
      parts.push(
        '## User Preferences\n' +
        prefs.map((p) => `- ${p.key.replace('pref:', '')}: ${p.value}`).join('\n')
      );
    }

    if (parts.length === 0) return '';
    return '\n\n---\n\n' + parts.join('\n\n');
  }
}
