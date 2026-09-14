/**
 * Outcomes 2.0 bridge — draft/snapshot/revision/memory/review/graph
 * （从 preload.ts 迁出，2026-09-13 拆分；纯 invoke 通道，契约由主进程校验）。
 */
import { ipcRenderer } from 'electron';


export const outcomes2Bridge = {
  // ── Outcomes 2.0（draft/snapshot/revision/memory/review/graph；registerOutcomes2Ipc）──
  outcome2DraftOpen: async (request: { projectId: string; outcomeId: string; version?: number }) =>
    ipcRenderer.invoke('outcomes2:draft:open', request) as Promise<{ ok: boolean; code?: string; outcome?: unknown; draft?: unknown; conflict?: boolean; requestedHistorical?: boolean }>,
  outcome2DraftGet: async (request: { projectId: string; outcomeId: string }) =>
    ipcRenderer.invoke('outcomes2:draft:get', request) as Promise<unknown>,
  outcome2DraftSave: async (request: { projectId: string; outcomeId: string; baseVersion: number; content: unknown; updatedBy: 'human' | 'ai_revision' | 'office_sync'; force?: boolean }) =>
    ipcRenderer.invoke('outcomes2:draft:save', request) as Promise<{ ok: boolean; code?: string; value?: { draft: unknown; conflict: boolean } }>,
  outcome2DraftClear: async (request: { projectId: string; outcomeId: string }) =>
    ipcRenderer.invoke('outcomes2:draft:clear', request) as Promise<{ ok: boolean }>,
  outcome2DraftResolveConflict: async (request: { projectId: string; outcomeId: string; action: 'discard' | 'keep' | 'rebase' }) =>
    ipcRenderer.invoke('outcomes2:draft:resolveConflict', request) as Promise<{ ok: boolean; code?: string; value?: { draft: unknown } }>,
  outcome2SnapshotCreate: async (request: { projectId: string; outcomeId: string; reason: 'autosave' | 'manual' | 'before_ai_revision' | 'before_import' | 'before_office_sync' | 'before_restore'; content?: unknown; baseVersion?: number }) =>
    ipcRenderer.invoke('outcomes2:snapshot:create', request) as Promise<{ ok: boolean; code?: string; value?: unknown }>,
  outcome2SnapshotList: async (request: { projectId: string; outcomeId: string }) =>
    ipcRenderer.invoke('outcomes2:snapshot:list', request) as Promise<unknown[]>,
  outcome2SnapshotRestore: async (request: { projectId: string; snapshotId: string }) =>
    ipcRenderer.invoke('outcomes2:snapshot:restore', request) as Promise<{ ok: boolean; code?: string; value?: { draft: unknown; snapshot: unknown } }>,
  outcome2SnapshotPurge: async (request: { projectId: string; outcomeId: string; scope?: 'auto' | 'all' }) =>
    ipcRenderer.invoke('outcomes2:snapshot:purge', request) as Promise<{ ok: boolean; deleted: number }>,
  outcome2RevisionCreate: async (request: { projectId: string; outcomeId: string; instruction: string; createdBy: 'ai' | 'review_issue' | 'conversation' | 'user'; conversationId?: string | null; reviewIssueId?: string | null; proposals: Array<{ target: unknown; after: unknown; reason: string; sourceRefs?: unknown[]; evidenceIds?: string[] }> }) =>
    ipcRenderer.invoke('outcomes2:revision:create', request) as Promise<{ ok: boolean; code?: string; message?: string; value?: { set: unknown; revisions: unknown[] } }>,
  outcome2RevisionListSets: async (request: { projectId: string; outcomeId: string }) =>
    ipcRenderer.invoke('outcomes2:revision:listSets', request) as Promise<unknown[]>,
  outcome2RevisionGetSet: async (request: { projectId: string; setId: string }) =>
    ipcRenderer.invoke('outcomes2:revision:getSet', request) as Promise<{ set: unknown; revisions: unknown[] } | null>,
  outcome2RevisionAccept: async (request: { projectId: string; setId: string; revisionId: string }) =>
    ipcRenderer.invoke('outcomes2:revision:accept', request) as Promise<{ ok: boolean; code?: string; value?: { draft: unknown; revision: unknown; set: unknown } }>,
  outcome2RevisionReject: async (request: { projectId: string; setId: string; revisionId: string }) =>
    ipcRenderer.invoke('outcomes2:revision:reject', request) as Promise<{ ok: boolean; code?: string; value?: { revision: unknown; set: unknown } }>,
  outcome2RevisionAcceptSet: async (request: { projectId: string; setId: string }) =>
    ipcRenderer.invoke('outcomes2:revision:acceptSet', request) as Promise<{ ok: boolean; code?: string; value?: { accepted: number; stale: number; rejected: number; failed: number } }>,
  outcome2RevisionRejectSet: async (request: { projectId: string; setId: string }) =>
    ipcRenderer.invoke('outcomes2:revision:rejectSet', request) as Promise<{ ok: boolean; code?: string; value?: { rejected: number } }>,
  outcome2RevisionCancelSet: async (request: { projectId: string; setId: string }) =>
    ipcRenderer.invoke('outcomes2:revision:cancelSet', request) as Promise<{ ok: boolean; code?: string; value?: { set: unknown } }>,
  outcome2RevisionMarkStaleByHash: async (request: { projectId: string; outcomeId: string }) =>
    ipcRenderer.invoke('outcomes2:revision:markStaleByHash', request) as Promise<{ ok: boolean; marked: number }>,
  outcome2MemoryGet: async (request: { projectId: string; outcomeId: string }) =>
    ipcRenderer.invoke('outcomes2:memory:get', request) as Promise<unknown>,
  outcome2MemorySave: async (memory: unknown) =>
    ipcRenderer.invoke('outcomes2:memory:save', memory) as Promise<{ ok: boolean; code?: string; value?: unknown }>,
  outcome2MemoryPropose: async (request: { projectId: string; outcomeId: string; field: string; value: unknown; reason: string }) =>
    ipcRenderer.invoke('outcomes2:memory:propose', request) as Promise<unknown>,
  outcome2MemoryListProposals: async (request: { projectId: string; outcomeId: string; status?: 'pending' | 'accepted' | 'rejected' }) =>
    ipcRenderer.invoke('outcomes2:memory:listProposals', request) as Promise<unknown[]>,
  outcome2MemoryAcceptProposal: async (request: { projectId: string; proposalId: string }) =>
    ipcRenderer.invoke('outcomes2:memory:acceptProposal', request) as Promise<{ ok: boolean; code?: string; value?: unknown }>,
  outcome2MemoryRejectProposal: async (request: { projectId: string; proposalId: string }) =>
    ipcRenderer.invoke('outcomes2:memory:rejectProposal', request) as Promise<{ ok: boolean }>,
  outcome2ReviewStart: async (request: { projectId: string; outcomeId: string; mode: string; baseVersion: number; baseDraftHash: string }) =>
    ipcRenderer.invoke('outcomes2:review:start', request) as Promise<unknown>,
  outcome2ReviewListRuns: async (request: { projectId: string; outcomeId: string }) =>
    ipcRenderer.invoke('outcomes2:review:listRuns', request) as Promise<unknown[]>,
  outcome2ReviewListIssues: async (request: { projectId: string; outcomeId: string; status?: string }) =>
    ipcRenderer.invoke('outcomes2:review:listIssues', request) as Promise<unknown[]>,
  outcome2ReviewIssueAdd: async (issue: unknown) =>
    ipcRenderer.invoke('outcomes2:review:issue:add', issue) as Promise<unknown>,
  outcome2ReviewIssueUpdate: async (request: { projectId: string; issueId: string; status: string }) =>
    ipcRenderer.invoke('outcomes2:review:issue:update', request) as Promise<unknown>,
  outcome2ReviewCancel: async (request: { projectId: string; runId: string }) =>
    ipcRenderer.invoke('outcomes2:review:cancel', request) as Promise<{ ok: boolean }>,
  outcome2ReviewMarkStaleByDraftHash: async (request: { projectId: string; outcomeId: string; currentDraftHash: string | null }) =>
    ipcRenderer.invoke('outcomes2:review:markStaleByDraftHash', request) as Promise<{ ok: boolean; marked: number }>,
  outcome2GraphUpsertNode: async (node: unknown) =>
    ipcRenderer.invoke('outcomes2:graph:upsertNode', node) as Promise<{ ok: boolean; code?: string; value?: unknown }>,
  outcome2GraphUpsertEdge: async (edge: unknown) =>
    ipcRenderer.invoke('outcomes2:graph:upsertEdge', edge) as Promise<{ ok: boolean; code?: string; value?: unknown }>,
  outcome2GraphNodes: async (request: { projectId: string }) =>
    ipcRenderer.invoke('outcomes2:graph:nodes', request) as Promise<unknown[]>,
  outcome2GraphEdges: async (request: { projectId: string }) =>
    ipcRenderer.invoke('outcomes2:graph:edges', request) as Promise<unknown[]>,
  outcome2GraphConfirmNode: async (request: { projectId: string; nodeId: string }) =>
    ipcRenderer.invoke('outcomes2:graph:confirmNode', request) as Promise<{ ok: boolean; code?: string; value?: unknown }>,
  outcome2GraphConfirmEdge: async (request: { projectId: string; edgeId: string }) =>
    ipcRenderer.invoke('outcomes2:graph:confirmEdge', request) as Promise<{ ok: boolean; code?: string; value?: unknown }>,
  outcome2GraphRejectNode: async (request: { projectId: string; nodeId: string }) =>
    ipcRenderer.invoke('outcomes2:graph:rejectNode', request) as Promise<{ ok: boolean; code?: string; value?: unknown }>,
  outcome2GraphRejectEdge: async (request: { projectId: string; edgeId: string }) =>
    ipcRenderer.invoke('outcomes2:graph:rejectEdge', request) as Promise<{ ok: boolean; code?: string; value?: unknown }>,
  outcome2GraphDedupCandidate: async (request: { projectId: string; label: string; canonicalEntityType?: string | null; canonicalEntityId?: string | null }) =>
    ipcRenderer.invoke('outcomes2:graph:dedupCandidate', request) as Promise<unknown>,
  outcome2ReviewRun: async (request: { projectId: string; outcomeId: string; mode: 'full' | 'argument' | 'evidence' | 'theory' | 'method' | 'structure' | 'language' | 'submission_check' }) =>
    ipcRenderer.invoke('outcomes2:review:run', request) as Promise<{ ok: boolean; code?: string; runId?: string; segments?: number; issues?: number }>,
  outcome2GraphExtractFromOutcome: async (request: { projectId: string; outcomeId: string }) =>
    ipcRenderer.invoke('outcomes2:graph:extractFromOutcome', request) as Promise<{ ok: boolean; code?: string; segments?: number; nodes?: number; edges?: number }>,
  outcome2GraphProjectClaimEvidence: async (request: { projectId: string }) =>
    ipcRenderer.invoke('outcomes2:graph:projectClaimEvidence', request) as Promise<unknown>,
  outcome2GraphProjectArgument: async (request: { projectId: string }) =>
    ipcRenderer.invoke('outcomes2:graph:projectArgument', request) as Promise<unknown>,
  outcome2GraphProjectKnowledge: async (request: { projectId: string }) =>
    ipcRenderer.invoke('outcomes2:graph:projectKnowledge', request) as Promise<unknown>,

};
