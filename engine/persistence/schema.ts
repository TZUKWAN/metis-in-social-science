/**
 * Schema definitions for the persistence layer.
 * Tables: sessions, messages, tool_results, checkpoints, workflow_runs, eval_runs,
 *         papers, notes, experiments.
 */

export const SCHEMA_VERSION = 13;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_activity INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  tool_calls TEXT,
  tool_call_id TEXT,
  name TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

-- Bounded durable AgentEvent ledger. Event identity is idempotent across retries;
-- sequence is monotonic within a run and supports renderer reconnect replay.
CREATE TABLE IF NOT EXISTS agent_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  correlation_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (run_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_agent_events_replay
  ON agent_events(session_id, run_id, sequence);

CREATE TABLE IF NOT EXISTS agent_runs (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  project_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  last_sequence INTEGER NOT NULL DEFAULT -1,
  events_pruned INTEGER NOT NULL DEFAULT 0,
  terminal_reason TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id, started_at);

CREATE TABLE IF NOT EXISTS tool_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ok',
  error TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_tool_results_session ON tool_results(session_id, created_at);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  status TEXT NOT NULL,
  turn_index INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL,
  current_step_id TEXT,
  step_results TEXT NOT NULL DEFAULT '{}',
  input TEXT NOT NULL DEFAULT '{}',
  errors TEXT NOT NULL DEFAULT '[]',
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY,
  suite_name TEXT NOT NULL,
  status TEXT NOT NULL,
  success_rate REAL NOT NULL DEFAULT 0,
  task_count INTEGER NOT NULL DEFAULT 0,
  passed_count INTEGER NOT NULL DEFAULT 0,
  results_json TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS papers (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  authors TEXT NOT NULL DEFAULT '[]',
  year INTEGER NOT NULL DEFAULT 0,
  venue TEXT NOT NULL DEFAULT '',
  abstract TEXT NOT NULL DEFAULT '',
  doi TEXT,
  arxiv_id TEXT,
  pdf_path TEXT,
  pdf_url TEXT,
  pdf_text TEXT NOT NULL DEFAULT '',
  citation_count INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  read_status TEXT NOT NULL DEFAULT 'unread',
  rating INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  paper_ids TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  scope TEXT NOT NULL DEFAULT 'global',              -- global|research
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  linked_paper_ids TEXT NOT NULL DEFAULT '[]',
  linked_note_ids TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned',
  parameters TEXT NOT NULL DEFAULT '{}',
  metrics TEXT NOT NULL DEFAULT '{}',
  tags TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  linked_paper_ids TEXT NOT NULL DEFAULT '[]',
  script_path TEXT,
  script_type TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'general',
  project_id TEXT,                                -- METIS-F12: NULL = global memory; set = project-scoped
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_category ON memory(category);
CREATE INDEX IF NOT EXISTS idx_memory_project ON memory(project_id);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '[]',
  env TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'other',
  path TEXT,
  size TEXT,
  content TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id, created_at);

-- ─── Unified Research Data Model (METIS-401) ─────────────────
-- Six core user-cognitive objects: Project, Source, Evidence, NoteCode, Claim, Artifact.
-- These are the single source of truth for research state. Existing papers/notes/experiments
-- tables remain and are mapped INTO this model (METIS-402 migration). All six carry:
-- id, timestamps, relations, status, version, provenance source, soft-delete.

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  original_intent TEXT NOT NULL DEFAULT '',
  research_question TEXT NOT NULL DEFAULT '',
  lifecycle TEXT NOT NULL DEFAULT 'draft',         -- METIS-102 ResearchLifecycle
  methodology TEXT NOT NULL DEFAULT '',
  discipline TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'user',             -- provenance: who/what created it
  deleted_at INTEGER
);

-- A library paper is a reusable source asset. Project membership belongs in a
-- relation table rather than papers.project_id (kept only as a legacy primary
-- project pointer for older clients).
CREATE TABLE IF NOT EXISTS paper_project_links (
  paper_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (paper_id, project_id),
  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  library_paper_id TEXT,                           -- canonical library asset mirrored by this project-local source
  kind TEXT NOT NULL,                              -- paper|book|pdf|web|archive|image|audio|data|other
  title TEXT NOT NULL DEFAULT '',
  authors TEXT NOT NULL DEFAULT '[]',              -- JSON array
  year INTEGER,
  venue TEXT NOT NULL DEFAULT '',
  identifier TEXT NOT NULL DEFAULT '',             -- DOI/arXiv/ISBN/URL (normalized)
  identifier_type TEXT NOT NULL DEFAULT '',        -- doi|arxiv|isbn|url|other
  file_path TEXT,
  external_url TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}',
  source_version_hash TEXT,                        -- hash of content for staleness detection
  provenance TEXT NOT NULL DEFAULT '{}',           -- JSON: where it came from, when, license
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  -- Anchor: precise location in the source (METIS-404). One of page/char-range/timestamp/region/row.
  anchor_type TEXT NOT NULL,                       -- page|char_range|timestamp|region|row|none
  anchor_start INTEGER,
  anchor_end INTEGER,
  page_number INTEGER,
  -- Snapshot of the cited text at capture time (so it survives source updates).
  snippet TEXT NOT NULL DEFAULT '',
  snippet_hash TEXT NOT NULL DEFAULT '',
  -- Relationship to the source version when captured (METIS-404 version hash).
  source_version_hash TEXT,
  confidence REAL NOT NULL DEFAULT 0.0,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS note_codes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  evidence_id TEXT,                                -- optional: coding applied to evidence
  code TEXT NOT NULL,                              -- the code/category label
  content TEXT NOT NULL DEFAULT '',                -- memo / coded text
  author TEXT NOT NULL DEFAULT 'human',            -- human|ai (METIS-804: strictly separated)
  confidence REAL NOT NULL DEFAULT 0.0,            -- for AI suggestions
  accepted INTEGER NOT NULL DEFAULT 0,             -- 0=pending, 1=accepted, -1=rejected
  tags TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_id) REFERENCES evidence(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  statement TEXT NOT NULL,
  claim_type TEXT NOT NULL DEFAULT 'assertion',    -- assertion|hypothesis|finding|limitation
  confidence REAL NOT NULL DEFAULT 0.0,
  status TEXT NOT NULL DEFAULT 'unsupported',      -- unsupported|supported|contested|refuted
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Claim-Evidence graph (METIS-405): many-to-many with relation type.
CREATE TABLE IF NOT EXISTS claim_evidence_links (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT 'supports',       -- supports|contradicts|qualifies
  weight REAL NOT NULL DEFAULT 1.0,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_id) REFERENCES evidence(id) ON DELETE CASCADE
);

-- research_artifacts: the unified Artifact object (METIS-401/601). Distinct from the legacy
-- artifacts table (session-scoped); this one is project-scoped and versioned.
CREATE TABLE IF NOT EXISTS research_artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  artifact_type TEXT NOT NULL,                     -- manuscript|chart|table|report|network|other
  review_status TEXT NOT NULL DEFAULT 'draft',     -- METIS-607: draft|pending|partial|verified|stale
  content_ref TEXT,                                -- path or inline content id
  input_hash TEXT,                                 -- hash of inputs (for staleness, METIS-603)
  provenance TEXT NOT NULL DEFAULT '{}',
  metadata TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Immutable artifact revisions. The current row in research_artifacts points to the
-- latest logical version, while every revision keeps its own manifest and payload.
CREATE TABLE IF NOT EXISTS artifact_versions (
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  manifest TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  thumbnail_ref TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'user',
  branch_from_version INTEGER,
  PRIMARY KEY (artifact_id, version),
  FOREIGN KEY (artifact_id) REFERENCES research_artifacts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS artifact_inputs (
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  input_kind TEXT NOT NULL,
  input_id TEXT NOT NULL,
  input_hash TEXT,
  PRIMARY KEY (artifact_id, version, input_kind, input_id),
  FOREIGN KEY (artifact_id, version) REFERENCES artifact_versions(artifact_id, version) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS artifact_citations (
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  PRIMARY KEY (artifact_id, version, source_id),
  FOREIGN KEY (artifact_id, version) REFERENCES artifact_versions(artifact_id, version) ON DELETE CASCADE,
  FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
);

-- Long-running research execution state. Runtime concepts stay internal, but these rows
-- provide the durable implementation required to resume the user-facing research plan.
CREATE TABLE IF NOT EXISTS research_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT '{}',
  provider_profile TEXT NOT NULL DEFAULT '{}',
  current_step_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  deleted_at INTEGER,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS research_checkpoints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  output_hash TEXT,
  completed_steps TEXT NOT NULL DEFAULT '[]',
  output TEXT NOT NULL DEFAULT '{}',
  decisions TEXT NOT NULL DEFAULT '[]',
  side_effect_keys TEXT NOT NULL DEFAULT '[]',
  pending_steps TEXT NOT NULL DEFAULT '[]',
  runtime_profile_version TEXT NOT NULL DEFAULT '',
  error_category TEXT,
  recovery_strategy TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES research_runs(id) ON DELETE CASCADE
);

-- Every AI suggestion and researcher decision is explicit and reversible.
CREATE TABLE IF NOT EXISTS research_decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  origin TEXT NOT NULL,
  before_value TEXT NOT NULL DEFAULT '{}',
  after_value TEXT NOT NULL DEFAULT '{}',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  undone_at INTEGER,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES research_runs(id) ON DELETE SET NULL
);

-- Idempotency ledger for imports, artifact writes and paid/external calls.
CREATE TABLE IF NOT EXISTS side_effect_ledger (
  idempotency_key TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT,
  operation TEXT NOT NULL,
  target_id TEXT,
  result_hash TEXT,
  committed_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES research_runs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_sources_project ON sources(project_id);
CREATE INDEX IF NOT EXISTS idx_paper_project_links_project ON paper_project_links(project_id, linked_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_project ON evidence(project_id);
CREATE INDEX IF NOT EXISTS idx_evidence_source ON evidence(source_id);
CREATE INDEX IF NOT EXISTS idx_note_codes_project ON note_codes(project_id);
CREATE INDEX IF NOT EXISTS idx_claims_project ON claims(project_id);
CREATE INDEX IF NOT EXISTS idx_claim_evidence_claim ON claim_evidence_links(claim_id);
CREATE INDEX IF NOT EXISTS idx_claim_evidence_evidence ON claim_evidence_links(evidence_id);
CREATE INDEX IF NOT EXISTS idx_research_artifacts_project ON research_artifacts(project_id);
CREATE INDEX IF NOT EXISTS idx_artifact_versions_artifact ON artifact_versions(artifact_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_artifact_inputs_input ON artifact_inputs(input_kind, input_id);
CREATE INDEX IF NOT EXISTS idx_artifact_citations_source ON artifact_citations(source_id);
CREATE INDEX IF NOT EXISTS idx_research_runs_project ON research_runs(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_checkpoints_run ON research_checkpoints(run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_decisions_project ON research_decisions(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_side_effect_ledger_run ON side_effect_ledger(run_id, committed_at DESC);

-- ─── Outcomes workbench (project-owned user deliverables) ───────────────
CREATE TABLE IF NOT EXISTS outcome_categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS outcomes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, category_id TEXT, title TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', current_version INTEGER NOT NULL DEFAULT 1, final_version INTEGER, preview_mime TEXT NOT NULL DEFAULT 'application/json', external_file_ref TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE, FOREIGN KEY (category_id) REFERENCES outcome_categories(id) ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS outcome_versions (outcome_id TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL DEFAULT '{}', content_hash TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT 'human', parent_version INTEGER, sources_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, PRIMARY KEY (outcome_id, version), FOREIGN KEY (outcome_id) REFERENCES outcomes(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS outcome_changes (id TEXT PRIMARY KEY, outcome_id TEXT NOT NULL, version INTEGER NOT NULL, actor TEXT NOT NULL, operation TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', context_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, FOREIGN KEY (outcome_id, version) REFERENCES outcome_versions(outcome_id, version) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS outcome_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'ppt', definition_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS scoped_conversations (id TEXT PRIMARY KEY, scope_kind TEXT NOT NULL, project_id TEXT NOT NULL, scenario_id TEXT, outcome_id TEXT, title TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE, FOREIGN KEY (outcome_id) REFERENCES outcomes(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS scoped_conversation_messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', sources_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, FOREIGN KEY (conversation_id) REFERENCES scoped_conversations(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS image_generation_settings (id INTEGER PRIMARY KEY CHECK (id = 1), provider TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', endpoint TEXT NOT NULL DEFAULT '', encrypted_api_key TEXT NOT NULL DEFAULT '', default_quality TEXT NOT NULL DEFAULT 'standard', updated_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS outcome_media (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, outcome_id TEXT NOT NULL, media_type TEXT NOT NULL, display_name TEXT NOT NULL, stored_name TEXT NOT NULL, byte_length INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE, FOREIGN KEY (outcome_id) REFERENCES outcomes(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_outcomes_project ON outcomes(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_outcomes_category ON outcomes(category_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_outcome_versions_outcome ON outcome_versions(outcome_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_outcome_changes_outcome ON outcome_changes(outcome_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scoped_conversations_scope ON scoped_conversations(project_id, scope_kind, scenario_id, outcome_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_scoped_conversation_messages ON scoped_conversation_messages(conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_outcome_media_owner ON outcome_media(project_id, outcome_id, created_at DESC);

INSERT OR IGNORE INTO schema_version (version) VALUES (${SCHEMA_VERSION});
`;
