/**
 * Navigation visibility config (METIS-506).
 *
 * Builds the user-facing nav list from the diagnostic-mode gate (METIS-209). In normal mode
 * only research actions appear; technical entries (Skill/MCP/Sandbox/Eval/Terminal/Runtime)
 * are hidden and reachable only under 设置 > 高级 > 开发者诊断.
 */

import { isNavVisible } from '../../engine/capabilities/DiagnosticMode.js';

export interface NavEntry {
  id: string;
  /** User-facing label key (METIS-107 dictionary — no technical jargon). */
  labelKey: string;
  /** The three top-level entries (METIS-103). */
  isTopLevel: boolean;
}

/**
 * The canonical normal-mode nav. Three top-level entries + research sub-entries that live
 * inside a project. Every entry here is user-facing-research terminology; nothing technical.
 */
const NORMAL_NAV: NavEntry[] = [
  { id: 'projects', labelKey: 'nav.projects', isTopLevel: true },
  { id: 'library', labelKey: 'nav.library', isTopLevel: true },
  { id: 'settings', labelKey: 'nav.settings', isTopLevel: true },
  // project-internal modes (METIS-104)
  { id: 'converse', labelKey: 'nav.converse', isTopLevel: false },
  { id: 'read', labelKey: 'nav.read', isTopLevel: false },
  { id: 'analyze', labelKey: 'nav.analyze', isTopLevel: false },
  { id: 'write', labelKey: 'nav.write', isTopLevel: false },
];

/**
 * Technical entries that ONLY appear in diagnostic mode. Their label keys intentionally
 * use technical terms — they are developer-facing, never shown to a researcher.
 */
const DIAGNOSTIC_NAV: NavEntry[] = [
  { id: 'evals', labelKey: 'nav.evals', isTopLevel: false },
  { id: 'mcp_admin', labelKey: 'nav.mcpAdmin', isTopLevel: false },
  { id: 'skill_admin', labelKey: 'nav.skillAdmin', isTopLevel: false },
  { id: 'terminal', labelKey: 'nav.terminal', isTopLevel: false },
  { id: 'runtime', labelKey: 'nav.runtime', isTopLevel: false },
  { id: 'logs', labelKey: 'nav.logs', isTopLevel: false },
];

/** The full nav list for the current mode (filters technical entries when normal). */
export function getVisibleNav(): NavEntry[] {
  return [...NORMAL_NAV, ...DIAGNOSTIC_NAV].filter((e) => isNavVisible(e.id));
}

/** Only the three top-level entries (for the primary app rail). */
export function getTopLevelNav(): NavEntry[] {
  return NORMAL_NAV.filter((e) => e.isTopLevel);
}

/** Whether a given nav id is a technical (hidden-by-default) entry. */
export function isTechnicalNavEntry(id: string): boolean {
  return DIAGNOSTIC_NAV.some((e) => e.id === id);
}
