# Metis Personalization Architecture

## Decision

Metis separates a stable execution engine from user-owned research definitions.

The runtime does not seed or select domain scenarios. A scenario exists only after the
user creates, installs, or imports it. This keeps academic assumptions in editable data
rather than in application code.

## Definition graph

Five versioned definition types form the personalization graph:

```text
Scenario
  ├─ Agent[]
  │    ├─ Skill[]
  │    ├─ MCP[]
  │    ├─ tool[]
  │    ├─ memory
  │    └─ output
  ├─ Skill[]
  ├─ MCP[]
  ├─ Metis.md[]
  ├─ workflow[]
  ├─ memory
  ├─ Full Access
  └─ output
```

Definitions use stable namespaced IDs and immutable revisions. User editing produces a
new revision rather than mutating history.

## Persistence

`PersonalizationRepository` stores definitions, revisions, run manifests, run state,
asset bindings, and evidence envelopes in SQLite.

Skill/MCP package assets and project `Metis.md` files live on disk under main-process
control. Definitions refer to those assets through managed records rather than arbitrary
renderer paths.

No startup path calls `seedBuiltins`; existing internal factory rows from development or
older profiles are not projected into the user interface or selected by chat.

## Runtime resolution

When a user selects a scenario, main resolves the exact definition graph:

1. Decode the renderer request.
2. Load the requested enabled user scenario.
3. Load the exact Agent, Skill, MCP, and rule revisions.
4. Add active project `Metis.md` when a project is selected.
5. Validate dependency references and workflow bindings.
6. Create a resolved run manifest and prompt stack.
7. Bind the manifest to the session, project, scenario, rules, capabilities, and output
   contract.
8. Persist the frozen snapshot for restart recovery.

Normal chat with no scenario skips this resolution path. It does not fall back to an
internal general-research scenario.

## Rule precedence

Prompt layers are resolved from general to specific:

```text
system runtime policy
  -> global Metis.md
  -> selected scenario
  -> scenario Metis.md
  -> selected Agent
  -> selected Skill
  -> active project Metis.md
  -> current user instruction
```

The exact ordered stack is part of the run snapshot.

## Full Access and live steering

`FullAccessPolicy` is resolved in main and passed to `AgentLoop`, the workflow executor,
tool dispatcher, and managed MCP bridge. The renderer cannot add an authority field to an
ordinary chat request.

Full Access removes per-action confirmation. It does not remove the user's ability to
steer or interrupt a run. Steering instructions are queued against the active session;
interrupt propagates through the agent and tool execution path.

## Skill boundary

Skills enter through three modes:

- renderer-authored Markdown;
- a selected ZIP/directory package;
- a supported HTTPS/GitHub URL.

The main process validates and persists the source, assets, digest, and definition. A
simple input/output schema is represented as structured fields; complex existing schemas
are preserved unless the user explicitly replaces them.

## MCP boundary

MCP definitions enter through a requirement builder or URL installer. Activation uses a
managed runtime record. Executable, arguments, working directory, exposed tools, and
environment references come from the installed record rather than arbitrary renderer
fields.

Secrets are stored in the main-process vault and resolved by name at activation time.

## Truth boundary

Personalization may change research behavior but cannot authoritatively set:

- evidence observation state;
- source version or correction state;
- citation provenance;
- artifact integrity;
- publishable/claim-eligible status.

Those values come from repository state, adapters, evidence envelopes, receipts, and
artifact verification. The UI intentionally shows this as an automatic system layer
without turning it into a per-step permission flow.

## Presentation scope

The contract retains a capability value for future presentation work, but alpha.2 does
not seed, expose, or execute a presentation scenario. Template decomposition and layout
selection require a separate user-defined design before that space is enabled.
