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

  // ─── Cross-Session Memory ───────────────────────────────────

  recordKeyDecision(decision: string, context?: string): void {
    const now = Date.now();
    const key = `decision:${now}`;
    const value = context ? `${decision}\n\nContext: ${context}` : decision;
    this.store.setMemory(key, value, 'key_decision');
  }

  getKeyDecisions(limit = 20): MemoryEntry[] {
    return this.store.getMemoryByCategory('key_decision').slice(0, limit);
  }

  recordPreference(key: string, value: string): void {
    this.store.setMemory(`pref:${key}`, value, 'preference');
  }

  getPreference(key: string): string | undefined {
    return this.store.getMemory(`pref:${key}`)?.value;
  }

  getAllPreferences(): MemoryEntry[] {
    return this.store.getMemoryByCategory('preference');
  }

  // ─── General Memory ─────────────────────────────────────────

  set(key: string, value: string, category = 'general'): void {
    this.store.setMemory(key, value, category);
  }

  get(key: string): string | undefined {
    return this.store.getMemory(key)?.value;
  }

  getByCategory(category: string): MemoryEntry[] {
    return this.store.getMemoryByCategory(category);
  }

  delete(key: string): void {
    this.store.deleteMemory(key);
  }

  // ─── Context Injection ──────────────────────────────────────

  /**
   * 构建注入 AgentLoop system prompt 的记忆上下文。
   * 包含 project memory + 最近的关键决策 + 用户偏好。
   */
  buildMemoryContext(): string {
    const parts: string[] = [];

    const projectMemory = this.loadProjectMemory();
    if (projectMemory.trim()) {
      parts.push('## Project Memory\n' + projectMemory.trim());
    }

    const decisions = this.getKeyDecisions(10);
    if (decisions.length > 0) {
      parts.push(
        '## Recent Key Decisions\n' +
        decisions.map((d) => `- ${new Date(d.updatedAt).toLocaleDateString()}: ${d.value}`).join('\n')
      );
    }

    const prefs = this.getAllPreferences();
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
