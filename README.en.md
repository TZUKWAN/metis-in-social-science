<div align="center">

# 📖 Metis in Social Science

# A Local-First AI Research Workbench

**Executable Scenarios × Runtime-Enforced Research Integrity**

Built for social science and every kind of evidence-based writing:
AI conversation, literature management, deep PDF reading, notes, deliverable
editing, and reproducible research workflows — in one desktop workspace,
with **integrity as a system property, not model discretion**.

[⬇️ Download for Windows](https://github.com/TZUKWAN/metis-in-social-science/releases/latest) ·
[🀄 中文文档](README.md) ·
[🧩 Personalization Guide](docs/PERSONALIZATION_GUIDE.md) ·
[📝 Changelog](docs/RELEASE_NOTES_v0.1.0-alpha.2.md) ·
[🐛 Issues](https://github.com/TZUKWAN/metis-in-social-science/issues)

`Windows x64` · `Apache-2.0` · `Electron 41 + React 19 + TypeScript` · `Local SQLite`

</div>

---

## 🤔 What is Metis?

Social scientists juggle four disconnected tools — reference managers, PDF readers,
note-taking and writing apps, plus a generic AI chat window. Context is rebuilt by
hand at every boundary, provenance decays with every copy-paste, and audit trails
do not survive tool borders.

Meanwhile, the integrity risks of AI-assisted research are measurable: audits of
ChatGPT-generated references found substantial fabrication; an agent that *claims*
it ran an experiment — citing numbers no tool ever produced — is producing
**paper-shaped text, not paper-shaped evidence**.

> **Metis' answer**: turn both concerns into runtime-computed properties —
> what AI is allowed to do (executable scenarios), and whether output deserves
> academic trust (enforced integrity).

Metis is **local-first**: the primary store is a SQLite database on your own
machine, API keys live in OS-level secure storage, and data leaves your machine
only when you explicitly invoke a model call, academic API query, or mail fetch.

---

## 🎯 Two Design Commitments

### 1️⃣ Executable Scenarios

Research workflows are versioned, dependency-resolvable configuration graphs —
not prompt piles. Scenarios bind agents, skills, MCP servers, rules documents
(Metis.md), multi-step workflows, memory policies, and output contracts.

- At session start, a scenario compiles into a **frozen run manifest**
  (every prompt layer carries a SHA-256 digest)
- A running session executes its frozen manifest; **edits only create future revisions**
- Authoring is LLM-assisted but constrained by **deterministic phase gates and a
  trust boundary** — identity, revision, and provenance fields are pinned to the
  persisted definition. **The model cannot rewrite its own scaffolding.**

### 2️⃣ Runtime-Enforced Integrity

Evidence ledgering, numeric-claim tracing, cross-validated references,
cryptographically signed citation receipts, and a nine-dimension integrity report —
all computed by **deterministic engine code** that prompts, scenario text, or agent
output **cannot switch off**.

| You control | The Metis runtime controls |
| --- | --- |
| Research behavior, roles, workflows, tools, memory, outputs, quality bars | Execution snapshots, evidence ledger, source states, revision identity, provenance, integrity reports |
| Which skills or MCP servers to install and bind | How installed code registers, how observations are recorded |
| When to steer, stop, edit, archive, restore | Whether a run may claim "verified, revised, publishable" |

---

## 📸 Screenshots

> Captured from the running system (`docs/screenshots/`).

| | |
| --- | --- |
| ![Personalization Center](docs/screenshots/personalization-center.png) | ![Scenario Workbench](docs/screenshots/scenario-builder.png) |
| *Personalization Center — five user-owned definition stores* | *Scenario Workbench — library · phased editor · AI assistant* |
| ![Provider Setup](docs/screenshots/provider-setup.png) | ![Paper Library](docs/screenshots/paper-library.png) |
| *Model connections — any OpenAI-compatible endpoint* | *Paper library with collections, tags, and reading state* |

---

## 🧩 Core Features

### 🎬 Scenario AI Compiler

Describe what you need in natural language; the compiler builds the scenario in
**five phases, each closed by a deterministic acceptance gate** — failures return
to the model immediately with concrete issues instead of exploding at the end:

| Phase | Content | Gate (excerpt) |
| --- | --- | --- |
| 1️⃣ Basics | name · description · capability | name non-empty; description ≥ 20 chars; capability set |
| 2️⃣ Deliverable | type · length · sections | type in enum; length present; sections with stable ids & titles |
| 3️⃣ Workflow | steps · prompts · criteria | every step has stable id, name, dedicated prompt, criteria |
| 4️⃣ Rules | Metis.md layer | rendered rules are not an empty template |
| 5️⃣ Output plan | format · artifacts · quality | primary deliverable, supporting artifacts, quality criteria complete |

**Trust boundary**: compiler responses are parsed at a strict boundary — identity
fields are pinned from the persisted scenario; strict Zod validation rejects the
whole candidate on failure.

**Authoring experience**: each phase researches online first, then writes piece by
piece with live updates in the editor; missing skills/MCP servers are
**auto-searched, verified, installed, and bound** (visible, auditable, uninstallable);
the result is auto-saved, with an unsaved-changes prompt on leave.

### 🔬 Integrity Pipeline

Every run ends with an **honest report**, not just plausible text:

- **Evidence Ledger** — SHA-256 of every tool call's input/output, raw I/O retained;
  tampering is detectable by re-hashing
- **Self-Deception Guard** — numeric-claim tracing, experiment-execution proof,
  fabricated DOI/arXiv detection, self-consistency scan
- **Citation Truth Receipts** — references cross-validated against title/author/year;
  HMAC-signed with TTL and constant-time verification; keys in the OS vault
- **Nine-dimension weighted score** (reproducibility, numeric tracing, reference
  authenticity, tool-audit completeness, self-consistency, retraction screening,
  provenance coverage, claim faithfulness, writing quality) with verdict bands:
  **S ≥ 80 pass · 60–79 warn · < 60 fail**
- **Non-switchable runtime layer** — hard safety boundary (destructive-command
  blocklist, quote-confusion resistant), capability permissions, evidence and
  revision identity: all outside the model's action space

> ⚠️ The integrity score is **decision support, not proof** — green means "no
> automated check failed"; it guides human review rather than replacing it.

### 🤖 Agent Engine

A framework-free TypeScript turn-based core (deliberately no agent framework, so
the trust boundary stays auditable):

- **Budgeted context assembly** — six built-in profiles (micro_4k → deep, 4K–200K tokens)
- **Semantic overflow recovery** — aggressive history recompression and *continue the
  same step* instead of blind retries
- **Loop guards** — identical-response detection (k=3, argument fingerprints included),
  session tool-call budget, bounded temperature escalation on repeated repair
- **Hard safety boundary** — destructive commands (recursive deletes, formatting,
  shutdown, forced VCS operations) rejected by pattern analysis that deliberately
  resists quote obfuscation; cannot be disabled by any configuration
- **Human-in-the-loop approvals** — gated tools pause the run until a human decides
- **Bounded repair loops** — completion criteria are enforced; weak output is repaired
  in-step (≤5 iterations, ≤2 retries per step), never silently advanced

### 📚 Literature & Reading

Deep PDF reading (persistent highlights/annotations, region notes, AI explanation,
STALE detection) · NCPSSD & OpenAlex search · metadata auto-completion · arXiv RSS
with AI summaries · Ctrl+K full-text search · BibTeX/CSV/RIS/HTML export ·
evidence anchors pinning claims to exact source locations

### 📝 Outcome Workbench (Word / PPT)

In-app DOCX/PPTX editing with element-level formatting, version history and review
states, AI collaboration (full-document and selection-scoped edits saved as new
versions), import/export — and a **fail-closed export gate**: citations must carry
fresh truth receipts, numeric claims need evidence bindings, figure/table references
must resolve to real artifacts.

### 🧠 Personalization Center

Five **empty** definition stores out of the box — no preset journal templates or
demo workflows: **scenarios · agents · skills · MCP servers · Metis.md rules**.
Every save creates an immutable revision (r+1); earlier revisions are restorable;
definition graphs export/import as bundles (credentials never included).

### 🆓 Free Model Center (experimental)

A batched, rate-limited subsystem that discovers and registers on widely deployed
open-source "new-api" style OpenAI-compatible gateway sites (status probe →
verification code via IMAP → registration → login → quota check → token minting).
A **pricing-table gate** keeps the free list honest: a model is free only if its
pricing entry is explicitly zero. Keys are encrypted into the OS vault. Explicitly
experimental; third-party dependent.

---

## 🏗️ Architecture

Three-layer desktop architecture with **contract-first IPC** — every cross-boundary
payload is strictly schema-validated:

```
Renderer — React 19 SPA (sandboxed, no Node) · 24 top-level pages
Preload bridge — contextIsolated whitelist API (~1,940 lines)
Main process — ~90 service modules + the Metis engine
  (AgentLoop · ContextEngine · EvidenceLedger · IntegrityReporter ·
   SelfDeceptionGuard · CitationTruth · scenario compiler + gates · MCP manager)
Persistence — local SQLite (better-sqlite3) · OS key vault · project workspace files
```

**Implementation metrics** (measured on the release tree): 635 TypeScript/TSX source
files (≈8.3 MB) · main.ts 9,911 lines · preload.ts 1,940 lines · ≈90 main-process
service modules · 409 test files · recorded engine suite run 154 files / 1,843 tests
all green · recorded frontend suite 1,141 tests all green · 4 typecheck projects,
zero errors.

---

## 📦 Install

1. Download `Metis-Research-Workbench-Setup-<version>-x64.exe` from
   [**Releases**](https://github.com/TZUKWAN/metis-in-social-science/releases/latest)
2. Run the installer (custom directory supported)
3. If Windows SmartScreen appears (the installer is not code-signed), choose
   **"More info → Run anyway"**
4. On first launch, configure any OpenAI-compatible provider (base URL + API key +
   model); keys are masked and stored in the OS vault, never echoed back

---

## 🛠️ Development

```bash
git clone https://github.com/TZUKWAN/metis-in-social-science.git
cd metis-in-social-science
npm install

npm run dev:electron      # development (Vite HMR + Electron)
npm run build             # production build
npm test                  # test suites
npm run typecheck         # 4 projects, zero errors

# Package a Windows installer (NSIS → release/)
npm run rebuild:electron
npx electron-builder --win nsis
```

> 💡 `better-sqlite3` is a native module: development (Node ABI) and packaging
> (Electron ABI) need different binaries — switch with `npm run rebuild:node` /
> `npm run rebuild:electron`.

---

## 🗺️ Positioning & Limits (honest statement)

- **Reference managers** curate catalogs well but are not built to execute research
  workflows or compute evidence integrity — Metis complements them
- **Autonomous "AI scientist" systems** prove end-to-end generation is feasible but
  treat integrity as a post-hoc patch; Metis puts the integrity substrate first and
  bounds autonomy with repair-loop caps, pause/cancel, and approval queues
- **Generic agent frameworks** provide orchestration primitives but lack in-platform
  scholarly guarantees (citation receipts, retraction screening, claim manifests)

**Known limits**: no benchmark evaluation (implementation metrics and recorded test
runs only) · boundary guards are heuristic (numeric tracing is text-based; the safety
boundary is pattern-based) · the integrity score is decision support, not proof ·
the free-model subsystem is optional, experimental, third-party dependent ·
Windows x64 only at present.

---

## 🤝 Contributing · 📄 License

[Contributing](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md) ·
[Security](SECURITY.md) · [Apache License 2.0](LICENSE)

---

<div align="center">

**Metis — your research, your rules, your local machine.**
**Every deliverable comes with an honest report of what the system did,
and how much of it is verifiable.**

</div>
