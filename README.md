<div align="center">

# Metis in Social Science

### A local-first AI research workbench for literature, evidence, analysis, and writing

[![Release](https://img.shields.io/github/v/release/TZUKWAN/metis-in-social-science?include_prereleases&label=release)](https://github.com/TZUKWAN/metis-in-social-science/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-9b4f2f)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20x64-3b5268)](https://github.com/TZUKWAN/metis-in-social-science/releases)
[![Electron](https://img.shields.io/badge/Electron-42-59667a)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-59667a)](https://react.dev/)

</div>

Metis Research Workbench is an open-source desktop research environment designed for
social-science work. It brings project organization, literature management, PDF
reading, evidence capture, connected notes, research writing, experiment tracking,
and AI-assisted workflows into one application.

Research data is persisted locally in an embedded SQLite database. There is no Metis
account or required Metis-hosted backend: you choose the OpenAI-compatible model
provider, and only operations that use that provider send request content to the
endpoint you configured.

> **Current release: 0.1.0-alpha.1 (pre-release).** The Windows installers are not
> Authenticode-signed, so Windows SmartScreen may display an unknown-publisher warning.
> Verify the published SHA-256 checksum before installation. See the
> [release notes](docs/RELEASE_NOTES_v0.1.0-alpha.1.md) for exact instructions.

**Download:** use the
[v0.1.0-alpha.1 GitHub Release](https://github.com/TZUKWAN/metis-in-social-science/releases/tag/v0.1.0-alpha.1)
for the Windows installer and published checksums.

---

## Screenshots

| Secure first-run provider setup | Project-scoped research notes in dark mode |
|:---:|:---:|
| ![Metis provider setup](docs/screenshots/provider-setup.png) | ![Metis research notes workspace](docs/screenshots/research-notes-dark.png) |

---

## Why Metis

Social-science researchers routinely juggle disconnected tools: a reference manager for
citations, a separate app for notes, a browser tab for PDFs, a LaTeX editor for papers,
and a spreadsheet for experiment parameters. Metis consolidates these into one
cohesive workspace augmented by an AI agent that can read papers, summarize findings,
draft sections, and execute multi-step research workflows on the researcher's behalf.

**Designed for researchers, with a verifiable engineering core.**

- No Docker or self-hosted server is required for daily desktop use.
- Bring your own OpenAI-compatible model endpoint and model name.
- Papers, notes, projects, sessions, and artifacts remain in the local data directory.
- Sensitive tool actions are mediated by explicit capabilities and approval gates.
- Structured runtime contracts validate data at the renderer/main-process boundary.

---

## Core Modules

| Module | Description |
|--------|-------------|
| **Dashboard** | Overview of research activity, reading goals, and recent work |
| **Chat** | Multi-session AI chat with Markdown rendering, code highlighting, tool-call cards, and skill-based prompting |
| **Goal-Driven Workflows** | Define a research goal, auto-generate an execution plan, and run it step-by-step with pause / resume / retry |
| **Paper Library** | Full CRUD for papers with BibTeX import, PDF attachment, tags, ratings, and reading status tracking |
| **Collections** | Organize papers into thematic collections for systematic review |
| **Knowledge Graph** | Visualize citation relationships and paper connections as an interactive graph |
| **Research Timeline** | Track research activity over time with heatmaps and activity trends |
| **LaTeX Editor** | Live preview with KaTeX math rendering, templates, citation integration, and real `pdflatex` compilation |
| **PDF Reader** | In-app PDF viewer with text extraction, search, and outline navigation |
| **Notes** | Markdown-aware research notes that link to papers and projects |
| **Experiments** | Track experiments with parameters, metrics, and status across runs |
| **Current-affairs research** | Review time-sensitive sources, bind approvals to verified source snapshots, preview the report, and export auditable artifacts |
| **Evals** | Run automated evaluation suites against the AI agent with quality gates (dev / candidate / release) |

---

## Architecture

```
+---------------------------------------------------------------+
|                     Renderer (React 19)                        |
|   Chat - Goal - Papers - Graph - Timeline - LaTeX - PDF - ...  |
+---------------------------------------------------------------+
|              IPC Bridge (contextBridge / preload)               |
+---------------------------------------------------------------+
|                     Main Process (Node.js)                      |
|   AgentLoop - ToolRegistry - MCPManager - GoalEngine - ...     |
+---------------------------------------------------------------+
|                 Engine Layer (TypeScript, test-covered)         |
|  +----------+ +-----------+ +-----------+ +--------------+     |
|  | AgentLoop| | ToolDisp. | | ContextEng| | WorkflowEng  |     |
|  +----------+ +-----------+ +-----------+ +--------------+     |
|  +----------+ +-----------+ +-----------+ +--------------+     |
|  |EvalRunner| |GoalEngine | | MemoryMgr | | MCPManager   |     |
|  +----------+ +-----------+ +-----------+ +--------------+     |
|  +----------+ +-----------+ +-----------+ +--------------+     |
|  | SkillReg.| | HITLCore  | | Evidence  | | RAG / PDF    |     |
|  +----------+ +-----------+ +-----------+ +--------------+     |
+---------------------------------------------------------------+
|             Persistence Layer (better-sqlite3, WAL mode)        |
|   papers - notes - experiments - sessions - messages - ...     |
+---------------------------------------------------------------+
```

The engine is a self-contained TypeScript library that can run independently of
Electron. This separation keeps the agent logic
testable in isolation via Vitest without spinning up a full desktop environment.

---

## Quick Start

### Prerequisites

- **Node.js** 20 LTS or newer (developed on Node 25.6.0)
- **npm** 10 or newer
- **pdflatex** (optional, only for in-app LaTeX compilation) — install
  [TeX Live](https://tug.org/texlive/) or [MiKTeX](https://miktex.org/)

### Install from source

```bash
git clone https://github.com/TZUKWAN/metis-in-social-science.git
cd metis-in-social-science
npm install
```

### Development commands

```bash
# Rebuild the native dependency for Electron.
# Run this after install, after an Electron upgrade, or after running
# Node-side tests (npm test rebuilds better-sqlite3 for Node ABI).
npm run rebuild:electron

# Start the Vite dev server and launch a visible Electron window.
npm run dev:electron

# Launch the already-built desktop application (no rebuild on launch).
npm start

# Run the full test suite (rebuilds for Node ABI, then runs Vitest).
npm test

# Lint with ESLint (flat config).
npm run lint

# Type-check app, engine, Node config, and Electron without emitting files.
npm run typecheck

# Build the production renderer/main-process output and rebuild native modules.
npm run build
```

### Build a Windows installer

```bash
npm run dist
```

This runs the full release pipeline: source provenance, type-check, clean build,
native rebuild, electron-builder packaging (NSIS + MSI), license/SBOM compliance,
and release verification. Output lands in `release/`.

---

## Configure Your AI Provider

Metis connects to any **OpenAI-compatible** API. On first launch:

1. Open **Settings**.
2. Enter your **API Base URL** (for example, `https://api.openai.com/v1`).
3. Enter your **API Key**.
4. Enter your **Model** name (for example, `gpt-4o`).
5. Click **Save**.

The app validates the connection, encrypts the key with Electron `safeStorage`, and
initializes the agent runtime. If secure OS-backed storage is unavailable, setup fails
closed rather than persisting an unprotected key.
All subsequent chat, goal execution, and eval runs use this provider.

---

## Data Privacy and Sovereignty

- **Local-first storage.** Research data — papers, notes, experiments, chat
  transcripts, and settings — is stored under the application's user-data directory.
  AI requests are sent only to the provider endpoint you configure.
- **Bring-your-own provider.** The AI provider API key is stored encrypted with the
  OS-native credential store and is transmitted only to the endpoint you configure.
- **No required Metis cloud.** The desktop application does not require a Metis
  account, cloud database, or hosted synchronization service.
- **Secure by default.** File operations are sandboxed to allowed directories; shell
  commands require human-in-the-loop approval; the renderer is isolated with
  `contextIsolation` enabled and `nodeIntegration` disabled.

---

## Security Model

| Layer | Protection |
|-------|-----------|
| Renderer | `contextIsolation: true`, `nodeIntegration: false`, navigation locked to the app entry point |
| File access | Path-traversal protection via an allow-listed read/write sandbox; symlink resolution before validation |
| Shell commands | Restricted execution surface with capability checks and approval requirements |
| Dangerous tools | Human-in-the-loop approval gate for `write_file`, `execute_command`, and similar operations |
| API key storage | Encrypted with Electron `safeStorage`; setup refuses durable storage when encryption is unavailable |
| External links | Validated IPC handler opens clean HTTPS links only; the renderer cannot navigate freely |

---

## Engine Capabilities

### AgentLoop
Streaming chat with real-time token delivery, a bounded tool-use loop, skill prompt
injection, and a hook system for extensibility.

### Tool Ecosystem
- **Built-in**: `read_file`, `write_file`, `execute_command`, `search_files`,
  `web_search`, `read_pdf`
- **MCP**: Connect external tool servers (filesystem, web search, databases) via the
  Model Context Protocol
- **Registry**: Dynamic tool registration with JSON-schema parameter validation

### Workflow Engine
Serial DAG execution with per-step AgentLoop invocation, pause / resume / retry / skip
controls, and real-time progress streaming to the renderer.

### Goal Engine
Natural-language goal to auto-generated plan, with plan validation, decomposition,
refinement via user feedback, and automatic archiving with memory extraction.

### Eval System
Pre-defined evaluation tasks (basic completion, tool use, constraint checking) with
three quality-gate profiles — dev, candidate, and release — and results persisted to
SQLite for trend tracking.

### Memory System
Project-scoped memory, conversation summaries, and cross-session key-decision
extraction so the agent retains context across research sessions.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop runtime | Electron 42 |
| Frontend | React 19, Vite 8, TypeScript 6.0 |
| State management | Zustand |
| Styling | CSS Variables (light / dark themes) |
| Internationalization | Custom hook-based (English / Chinese) |
| Math rendering | KaTeX |
| PDF rendering | pdfjs-dist |
| Markdown | react-markdown, remark-gfm |
| Code highlighting | Prism.js |
| Terminal emulation | xterm.js |
| Diagrams | React Flow |
| Database | better-sqlite3 (WAL mode) |
| Testing | Vitest 4, Testing Library |
| Linting | ESLint 10 (flat config), typescript-eslint |

---

## Testing

```bash
# Full suite
npm test

# Single file
npx vitest run tests/e2e/baseline.test.ts

# With coverage
npx vitest run --coverage
```

**Verified release baseline (2026-07-30): 3,271 tests passed in 741 suites, with zero
failures, skips, or todos.** The baseline covers the engine, tools, persistence,
security boundaries, memory, goals, MCP, renderer components, Electron contracts, and
end-to-end workflows. The packaged Windows application also passed a nine-step desktop
black-box flow covering navigation, PDF rendering, library import, note persistence,
full process restart, backup export, and visible error recovery.

---

## Project Structure

```
metis-workbench/
+- electron/           # Electron main process + preload bridge
|   +- main.ts         # Window, IPC, provider init, lifecycle
|   +- preload.ts      # Secure contextBridge IPC surface
+- engine/             # Core TypeScript engine
|   +- core/           # AgentLoop, types, hooks, secure storage
|   +- tools/          # ToolRegistry, ToolDispatcher, built-in tools
|   +- providers/      # OpenAI-compatible provider adapter
|   +- workflow/       # WorkflowEngine, DAG execution
|   +- goal/           # GoalEngine, GoalPlanner
|   +- evals/          # EvalRunner, GateEvaluator
|   +- memory/         # MemoryManager, project memory
|   +- mcp/            # MCPManager, StdioTransport
|   +- skills/         # SkillRegistry, default skills
|   +- hitl/           # Human-in-the-loop approval system
|   +- persistence/    # SQLite schema + PersistenceStore
|   +- context/        # ContextEngine (token budget management)
|   +- evidence/       # EvidenceLedger
|   +- behavior/       # BehaviorRegistry
|   +- runtime/        # IPC contracts and decoders
|   +- artifacts/      # Artifact manifests
|   +- export/         # Research export builder
|   +- latex/          # LaTeX log parser
|   +- writing/        # Current-affairs research services
+- src/                # Renderer (React)
|   +- pages/          # 12 page components
|   +- components/     # Reusable UI components
|   +- i18n/           # English / Chinese strings
|   +- store.ts        # Zustand store
|   +- App.tsx         # Root app + routing
|   +- App.css         # Global styles + theme variables
+- tests/              # Test suite
+- docs/               # Documentation and architecture records
+- build/              # Icons and build assets
+- package.json
```

---

## Roadmap

- [ ] Authenticode code signing for Windows installers
- [ ] macOS (dmg) and Linux (AppImage) builds
- [ ] Plugin SDK for custom tools and skills
- [ ] Citation manager integration (Zotero, Mendeley)
- [ ] Collaborative research workspaces (optional, local-network)
- [ ] RAG-based semantic search across the paper library

---

## Contributing

This project is in early alpha. Bug reports and focused pull requests are welcome.
Before opening an issue, search the existing tracker; when reporting a defect, include
the Metis version, Windows version, reproduction steps, expected behavior, and relevant
logs with credentials and private research content removed.

- [Open an issue](https://github.com/TZUKWAN/metis-in-social-science/issues/new)
- [View releases](https://github.com/TZUKWAN/metis-in-social-science/releases)

### Development setup checklist

1. `npm install`
2. `npm run rebuild:electron` (critical — see the note below)
3. `npm run typecheck` — confirm no type errors
4. `npm test` — confirm the baseline passes
5. `npm run dev:electron` — launch the dev build

> **Native module note.** The `npm test` script rebuilds `better-sqlite3` for the
> Node.js ABI. After running tests, you **must** run `npm run rebuild:electron`
> before launching the Electron app again, otherwise SQLite will fail to load with
> an `NODE_MODULE_VERSION` mismatch. This is expected behavior, not a bug.

---

## License

Metis in Social Science is licensed under the
[Apache License 2.0](LICENSE). The `private` package flag prevents accidental npm
publication; it does not restrict use under the repository license.

---

## Acknowledgements

Metis Research Workbench is built on outstanding open-source projects, including
Electron, React, Vite, better-sqlite3, pdf.js, KaTeX, xterm.js, React Flow, and many
others. Full third-party license information is bundled with each release
(`LICENSES.chromium.html` and SBOM provenance under `release/evidence/`).
