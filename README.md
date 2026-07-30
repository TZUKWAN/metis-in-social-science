<div align="center">

# Metis in Social Science

### A local-first AI research workbench for social science, humanities, and evidence-grounded writing

[Download for Windows](https://github.com/TZUKWAN/metis-in-social-science/releases/latest) ·
[Read the documentation](docs/PERSONALIZATION_GUIDE.md) ·
[Report an issue](https://github.com/TZUKWAN/metis-in-social-science/issues)

</div>

---

Metis is a desktop research environment that brings AI conversation, source management,
PDF reading, notes, analysis, writing, reproducible research workflows, and user-defined
Agents into one coherent workspace.

It is not a chat window with a few academic prompts attached. Metis maintains projects,
sources, sessions, artifacts, rules, tool connections, and execution state as first-class
objects. The application can therefore carry a research task from question formation to
evidence collection, analysis, drafting, revision, and export without forcing the user to
move context between unrelated tools.

The defining idea of the current version is simple:

> Metis does not decide what kind of researcher you are. It gives you the system for
> defining your own research scenarios, Agents, Skills, MCP services, workflows, memory,
> and output contracts.

## Product views

### Personalization Center

The Personalization Center starts empty. Every scenario is created or installed by the
user, and every dependency is visible by name.

![Personalization Center](docs/screenshots/personalization-center.png)

### Scenario builder

Each scenario can combine Agents, Skills, MCP servers, `Metis.md` rules, a multi-step
workflow, memory policy, output format, primary deliverable, supporting artifacts, and
quality criteria.

![Custom scenario builder](docs/screenshots/scenario-builder.png)

### Research library

PDFs, bibliographic records, collections, tags, reading status, and research artifacts
remain connected to the same project and conversation context.

![Paper library](docs/screenshots/paper-library.png)

## What Metis can do

### Work with an AI model as a research partner

- Connect to an OpenAI-compatible model provider from the desktop setup screen.
- Keep multiple research conversations and restore them after restart.
- Send ordinary questions without selecting a scenario.
- Select a user-created scenario when a task needs a specialized Agent and workflow.
- Stream responses, stop an active run, regenerate an answer, and continue from the same
  research context.
- Turn generated Markdown into a live artifact preview instead of leaving it trapped in
  the chat transcript.

### Organize research as projects rather than loose messages

- Create durable research projects with their own sources, notes, artifacts, and rules.
- Switch between conversation, reading, analysis, and writing modes without losing the
  active project.
- Preserve sessions, messages, source metadata, and artifacts in a local SQLite database.
- Keep project-level `Metis.md` instructions with the project rather than in a global
  prompt that silently affects unrelated work.

### Build and inspect a literature base

- Maintain a searchable paper library with collections, tags, archives, and reading
  status.
- Import local PDFs and bibliographic material.
- Read PDFs inside the workbench and move between papers and notes without leaving the
  application.
- Use DOI, Crossref, OpenAlex, Semantic Scholar, arXiv, RSS, Zotero, and related research
  adapters where configured.
- Track citation passports, triangulation, journal integrity signals, retractions, and
  evidence provenance through the engine layer.

### Read, annotate, analyze, and write in one workspace

- Use the PDF reader for close reading and document inspection.
- Keep durable notes with titles, body text, favorites, and project association.
- Explore research material through graph, timeline, comparison, and experiment views.
- Preview LaTeX-oriented output and maintain generated artifacts alongside their source
  conversations.
- Export library and research data through the available desktop export surfaces.

## Personalization without presets

Metis ships the editor and runtime, not a list of assumptions about what the user wants
to write. A fresh installation contains no journal, thesis, funding, monograph, policy,
or presentation scenario. The user decides which of those concepts should exist and how
they should work.

This is different from a prompt gallery. A Metis scenario is an executable configuration
graph with versioned dependencies.

### Scenarios

A scenario defines the overall research mode. The editor exposes:

- Name, description, enable state, and trigger phrases.
- Scenario capability and Full Access execution policy.
- Agent, Skill, MCP, and `Metis.md` bindings.
- Ordered workflow steps and step dependencies.
- Agent assignment, tools, Skills, MCP services, and turn budget for every step.
- Memory scope, retained decisions, retained artifacts, and summary budget.
- Output format and optional structured output schema.
- Primary deliverable, supporting artifacts, and user-written quality criteria.

The scenario is saved as a new revision. A running conversation receives a frozen
manifest, so editing a scenario does not silently change an already-running task.

### Agents

An Agent is a reusable role that can be shared by several scenarios. Users can configure:

- Role and system instructions.
- Optional model preference.
- Skills, tools, and MCP services.
- Memory behavior and summary limits.
- Output format, deliverable plan, and structured output requirements.
- Maximum turns and retry policy.

Agents are not hard-coded academic personas. A user may create a field interviewer, a
statistical reviewer, an archival source critic, an editor, or any other role the work
actually needs.

### Skills in three modes

Metis supports three ways to add a Skill:

1. **Write Markdown directly** — edit a `SKILL.md`-style instruction document inside the
   Personalization Center. This is the fastest path for users who do not want to build a
   package.
2. **Install a Skill package** — select a ZIP or directory containing instructions,
   scripts, references, schemas, and other assets.
3. **Install from a URL** — provide a GitHub or supported HTTPS source and let Metis
   download and register the Skill.

The visual Skill editor also exposes system instructions, tool and MCP bindings, turn
budget, package entry, and structured input/output fields. Simple schemas are edited one
field at a time; users do not need to hand-write JSON.

### MCP in two modes

MCP integration is available through two user-facing paths:

1. **Describe the requirement** — write what the MCP must do and let the managed builder
   create an installable local service.
2. **Install from a URL** — provide a supported MCP repository or package URL and install
   it into the managed runtime.

Installed MCP definitions retain their source, exposed tools, environment references,
and activation state. Secret values are stored separately and are not written into the
definition or exported with a personalization bundle.

### `Metis.md`

`Metis.md` is the user-owned rule layer. Rules can be scoped globally, to a scenario, or
to a project. Project rules are edited in the Personalization Center and are kept with the
actual project workspace.

Legacy `AGENTS.md` content is migrated without discarding the user's text. Existing
project changes use conflict-aware writes so one project cannot silently overwrite the
rules of another.

### Import, export, history, and recovery

- Export a selected definition together with its dependency graph.
- Import a personalization bundle without exporting credentials.
- Inspect immutable revision history.
- Restore a prior user revision.
- Archive definitions that are no longer needed.
- Keep installed Skills and MCP assets associated with their definitions after restart.

## Full Access, live control, and research integrity

Metis is designed for uninterrupted work. In Full Access mode it does not stop before
every tool action to request another confirmation. The user can instead guide the active
task with a message or interrupt it at any time.

Autonomy does not mean inventing research state. Evidence status, correction state,
source identity, provenance, and publishability are computed by the runtime rather than
accepted from editable scenario text. Those controls remain automatic and are shown in
the Personalization Center as part of the system layer, not as switches a prompt can turn
off.

The practical separation is:

| User controls | Metis runtime controls |
| --- | --- |
| Research behavior, roles, workflow, tools, memory, output, quality criteria | Execution snapshots, evidence envelopes, source state, correction state, provenance, integrity reports |
| Which Skill or MCP to install and bind | How installed code is registered and how observed results are recorded |
| When to steer, stop, edit, archive, or restore | Whether a run result may claim to be verified, corrected, or publishable |

## Installation

### Windows release

Open the [latest GitHub Release](https://github.com/TZUKWAN/metis-in-social-science/releases/latest)
and choose one of the published assets:

- `Metis-Research-Workbench-Setup-<version>-x64.exe` — standard NSIS installer.
- `Metis-Research-Workbench-<version>-x64.msi` — MSI package for managed Windows
  environments.
- The unpacked build, when provided, for portable inspection and testing.

Alpha builds may be unsigned. Windows SmartScreen can therefore display an
"unrecognized app" warning. Check the asset name and SHA-256 value shown in the release
notes before continuing.

### Build from source

Requirements:

- Windows 10 or Windows 11 for the packaged desktop target.
- Node.js 22 or newer.
- npm 10 or newer.
- Git.

```powershell
git clone https://github.com/TZUKWAN/metis-in-social-science.git
cd metis-in-social-science
npm ci
npm run build:electron
npm start
```

For development:

```powershell
npm run dev:electron
```

For a local Windows package:

```powershell
npm run pack
```

The repository uses `better-sqlite3`, which has separate Node and Electron native ABIs.
`npm test` rebuilds it for Node tests; `npm run build:electron` rebuilds it for the desktop
runtime.

## Configure a model provider

On first launch Metis opens a centered setup screen. Enter:

1. The base URL of an OpenAI-compatible API.
2. The API key.
3. The exact model name exposed by that service.

![Provider setup](docs/screenshots/provider-setup.png)

The key is handled by the Electron main process and stored with the operating system's
secure storage support. It is not written into a personalization definition, exported
bundle, or renderer-readable settings response.

## Data and privacy

Metis is local-first, not offline-only.

Stored locally:

- Projects, sessions, messages, notes, source metadata, artifacts, and personalization
  definitions.
- SQLite data and application configuration.
- Installed Skill/MCP assets and project `Metis.md` files.
- Receipt and integrity material used by the desktop runtime.

Sent externally only when the related feature is used:

- Conversation content and selected context to the configured model provider.
- Bibliographic or identifier queries to services such as Crossref, OpenAlex, arXiv, or
  Semantic Scholar.
- Network requests made by an explicitly installed Skill or MCP service.

Before using sensitive research material, review the privacy terms of the model provider
and every third-party integration you enable.

## Architecture

```text
┌──────────────────────────────── Electron renderer ────────────────────────────────┐
│ App shell · Projects · Chat · Library · PDF · Notes · Analysis · Personalization │
└─────────────────────────────── strict preload bridge ─────────────────────────────┘
                                        │
┌──────────────────────────────── Electron main ───────────────────────────────────┐
│ IPC validation · Provider · Persistence · Skill/MCP installers · File services   │
│ Personalization runtime · Managed MCP runtime · Evidence and artifact services   │
└───────────────────────────────────────┬───────────────────────────────────────────┘
                                        │
┌──────────────────────────────── Engine layer ────────────────────────────────────┐
│ AgentLoop · Tool dispatcher · Workflows · Memory · Research adapters · Contracts │
│ Versioned definitions · Run manifests · Evidence · Citation and source controls  │
└───────────────────────────────────────────────────────────────────────────────────┘
```

The renderer never receives unrestricted Node.js access. Desktop capabilities cross a
typed preload bridge, and long-running scenario execution is resolved in the main/engine
layers from a saved definition revision.

## Technology

| Layer | Main technologies |
| --- | --- |
| Desktop | Electron 41 |
| Interface | React 19, TypeScript 6, CSS design tokens |
| Build | Vite 8, electron-builder |
| Persistence | SQLite through better-sqlite3 |
| Documents | PDF.js, KaTeX, Markdown rendering |
| Agent runtime | OpenAI-compatible provider, tool dispatcher, MCP runtime |
| Validation | Zod contracts across renderer, preload, main, and engine boundaries |

## Repository layout

```text
electron/                 Electron main process and desktop services
engine/                   Agent, research, workflow, memory, and runtime contracts
src/                      React application and visual design system
src/personalization/      Personalization Center and supporting panels
tests/                    Unit, integration, Electron, and frontend tests
docs/                     Architecture, formats, guides, screenshots, release notes
scripts/                  Build, release, packaging, and acceptance utilities
```

## Development quality gates

```powershell
npm run typecheck
npm run lint
npm test
npm run build:electron
```

The release workflow additionally produces provenance, dependency/license reports,
package scans, and Windows assets. GUI acceptance uses disposable Electron profiles so
development checks do not read or modify a normal user's projects or provider key.

## Current limitations

- This is an alpha release. Back up important research material before upgrading.
- The packaged release currently targets Windows x64.
- Installers may be unsigned and can trigger SmartScreen.
- A compatible model API and the user's own provider credentials are required for AI
  responses.
- Metis deliberately ships without preconfigured research scenarios. Users must create
  or import the configurations they want.
- Presentation generation is not included as a built-in scenario. The product leaves
  that design space open for a future user-defined layout system.
- Some export workflows require external software, such as a TeX distribution.

## Contributing

Contributions are welcome in the form of bug reports, reproducible examples,
documentation improvements, interface refinements, new research adapters, Skills, MCP
integrations, and runtime improvements.

Before opening a pull request:

1. Create a focused branch.
2. Keep generated artifacts and local user data out of the commit.
3. Run type checking and the relevant tests.
4. Describe the user-visible behavior and how it was verified.
5. Include screenshots for interface changes.

See [CONTRIBUTING.md](CONTRIBUTING.md) and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for repository guidelines.

## License

Metis in Social Science is licensed under the
[Apache License 2.0](LICENSE).

## Project status

Metis is under active development. The goal is a research workbench that is free enough
to adapt to different scholars and structured enough to preserve evidence, context, and
reproducibility across long projects.
