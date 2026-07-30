"""Real-provider Personalization runtime and restart acceptance.

This runner copies only Electron-encrypted provider configuration and Chromium's
safeStorage state into a disposable profile. It never decrypts or records the API
key and never writes to the source profile. The disposable profile is used to:

1. physically author and save a Skill, Agent, scenario-scoped Metis.md, and zero-preset Scenario in the real UI;
2. hand the Scenario to Chat, physically type/send, and run it with the configured provider;
3. persist and open the generated content artifacts;
4. restart the complete Electron process and open the same artifacts again.

The JSON report contains only hashes, lengths, identifiers, statuses, and paths
inside the disposable evidence directory. Model output bodies are never written.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import pathlib
import re
import shutil
import sqlite3
import subprocess
import tempfile
import time
import traceback
import uuid
from typing import Any


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[1]
VISUAL_SCRIPT = PROJECT_ROOT / "scripts" / "electron-personalization-visual-acceptance.py"
CONFIG_RELATIVE_PATH = pathlib.Path("metis-data") / "provider-config.json"
DATABASE_RELATIVE_PATH = pathlib.Path("metis-data") / "metis.db"
SAFE_STORAGE_STATE_RELATIVE_PATH = pathlib.Path("Local State")
PRIMARY_NAME = "LIVE Personalization Report"
SUPPORTING_NAME = "Evidence Note"
QUALITY_NAME = "Sentinel appears in the primary output"
SGTOOL_LOG_PATTERN = re.compile(r"^SGTool_(\d+)\.log$", re.IGNORECASE)


def load_script(name: str, path: pathlib.Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load acceptance helper: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


visual = load_script("metis_personalization_visual", VISUAL_SCRIPT)
layout = visual.layout
launcher = visual.launcher


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def snapshot_sgtool_processes() -> dict[int, int]:
    """Return SGTool PID -> start time without inspecting unrelated process data."""
    command = (
        "Get-Process -Name SGTool -ErrorAction SilentlyContinue | ForEach-Object { "
        "try { '{0}|{1}' -f $_.Id, ([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds() } catch {} }"
    )
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command", command],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    if result.returncode != 0:
        return {}
    processes: dict[int, int] = {}
    for line in result.stdout.splitlines():
        try:
            pid_text, started_text = line.strip().split("|", 1)
            pid = int(pid_text)
            started_at = int(started_text)
        except (TypeError, ValueError):
            continue
        if pid > 0 and started_at > 0:
            processes[pid] = started_at
    return processes


def terminate_isolated_sgtool_locks(
    profile: pathlib.Path,
    baseline: dict[int, int],
    run_started_at: int,
) -> list[dict[str, Any]]:
    """Stop only new SGTool processes whose PID-named log is inside this profile."""
    profile_root = profile.resolve()
    current = snapshot_sgtool_processes()
    evidence: list[dict[str, Any]] = []
    log_root = profile / "AppData" / "LocalLow" / "SogouPY" / "LOG" / "APP"
    for log_path in log_root.glob("SGTool_*.log") if log_root.is_dir() else []:
        match = SGTOOL_LOG_PATTERN.fullmatch(log_path.name)
        if not match:
            continue
        try:
            resolved_log = log_path.resolve(strict=True)
            relative_log = resolved_log.relative_to(profile_root).as_posix()
        except (FileNotFoundError, OSError, ValueError):
            continue
        pid = int(match.group(1))
        started_at = current.get(pid)
        if pid in baseline or started_at is None or started_at < run_started_at:
            continue
        command = (
            f"$p=Get-Process -Id {pid} -ErrorAction Stop; "
            "if($p.ProcessName -ne 'SGTool'){exit 3}; "
            "$started=([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds(); "
            f"if($started -ne {started_at}){{exit 4}}; "
            f"Stop-Process -Id {pid} -Force; "
            f"Wait-Process -Id {pid} -Timeout 10 -ErrorAction SilentlyContinue"
        )
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-Command", command],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        still_running = pid in snapshot_sgtool_processes()
        evidence.append({
            "pid": pid,
            "startedAtUnixMs": started_at,
            "logPath": relative_log,
            "baselineProcess": False,
            "terminationExitCode": result.returncode,
            "terminated": result.returncode == 0 and not still_running,
        })
    return evidence


def sanitize_electron_log(path: pathlib.Path) -> None:
    """Retain startup evidence without persisting the configured endpoint."""
    if not path.is_file():
        return
    raw = path.read_text(encoding="utf-8", errors="replace")
    sanitized = re.sub(r"(baseUrl:\s*)\S+", r"\1[REDACTED]", raw)
    path.write_text(sanitized, encoding="utf-8")


def js(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def dispatch_key(cdp, key: str, code: str, virtual_key: int) -> None:
    for event_type in ("rawKeyDown", "keyUp"):
        cdp.call("Input.dispatchKeyEvent", {
            "type": event_type,
            "key": key,
            "code": code,
            "windowsVirtualKeyCode": virtual_key,
            "nativeVirtualKeyCode": virtual_key,
        })


def mark_element(cdp, expression: str, attribute: str) -> str:
    selector = f'[{attribute}="true"]'
    marked = cdp.evaluate(f"""
    (() => {{
      document.querySelectorAll({js(selector)}).forEach((item) => item.removeAttribute({js(attribute)}));
      const element = ({expression});
      if (!element) return false;
      element.setAttribute({js(attribute)}, 'true');
      return true;
    }})()
    """)
    require(marked is True, f"Could not mark required UI element: {attribute}")
    return selector


def select_value_physically(cdp, selector: str, value: str) -> dict[str, Any]:
    visual.scroll_to(cdp, selector)
    option = cdp.evaluate(f"""
    (() => {{
      const select = document.querySelector({js(selector)});
      if (!(select instanceof HTMLSelectElement)) return null;
      const index = [...select.options].findIndex((item) => item.value === {js(value)});
      return index < 0 ? null : {{ index, count: select.options.length }};
    }})()
    """)
    require(isinstance(option, dict), f"Select option is unavailable: {selector} -> {value}")
    hit = layout.physical_click(cdp, selector)
    dispatch_key(cdp, "Home", "Home", 36)
    for _ in range(int(option["index"])):
        dispatch_key(cdp, "ArrowDown", "ArrowDown", 40)
    dispatch_key(cdp, "Enter", "Enter", 13)
    layout.wait_for(cdp, f"document.querySelector({js(selector)})?.value === {js(value)}", timeout=10)
    return hit


def replace_bounded_number_physically(cdp, selector: str, value: int) -> None:
    """Replace a controlled number input without requiring a transient empty value.

    Personalization number fields immediately restore their previous bounded value
    when Backspace produces an empty string. Keeping the existing text selected and
    inserting the replacement exercises the real control while avoiding that invalid
    intermediate state.
    """
    target = str(value)
    visual.scroll_to(cdp, selector)
    layout.physical_click(cdp, selector)
    visual.select_all(cdp)
    cdp.call("Input.insertText", {"text": target})
    layout.wait_for(
        cdp,
        f"document.querySelector({js(selector)})?.value === {js(target)}",
        timeout=10,
    )


def open_personalization(instance: dict[str, Any]) -> None:
    cdp = instance["cdp"]
    if cdp.evaluate("Boolean(document.querySelector('.personalization-page'))") is not True:
        layout.physical_click(cdp, '[data-testid="personalization-trigger"]')
    layout.wait_for(cdp, "document.querySelector('.personalization-page')", timeout=30)


def open_personalization_kind(instance: dict[str, Any], index: int) -> dict[str, Any]:
    open_personalization(instance)
    cdp = instance["cdp"]
    selector = mark_element(
        cdp,
        f"document.querySelectorAll('.personalization-tabs button')[{index}]",
        "data-runtime-kind-tab",
    )
    visual.scroll_to(cdp, selector, "nearest")
    hit = layout.physical_click(cdp, selector)
    layout.wait_for(cdp, f"document.querySelector({js(selector)})?.getAttribute('aria-pressed') === 'true'", timeout=10)
    return hit


def create_definition_physically(instance: dict[str, Any], kind_index: int) -> str:
    cdp = instance["cdp"]
    open_personalization_kind(instance, kind_index)
    previous_ids = cdp.evaluate("[...document.querySelectorAll('[data-definition-id]')].map((item) => item.getAttribute('data-definition-id'))")
    require(isinstance(previous_ids, list), "Personalization definition list is unavailable")
    new_selector = mark_element(
        cdp,
        "document.querySelector('.personalization-library__header .btn-primary')",
        "data-runtime-new-definition",
    )
    visual.scroll_to(cdp, new_selector, "nearest")
    layout.physical_click(cdp, new_selector)
    previous_json = js(previous_ids)
    layout.wait_for(cdp, f"""
    (() => {{
      const previous = new Set({previous_json});
      const selected = document.querySelector('.personalization-card.selected [data-definition-id]');
      return Boolean(selected && !previous.has(selected.getAttribute('data-definition-id'))
        && document.querySelector('.personalization-editor'));
    }})()
    """, timeout=30)
    definition_id = cdp.evaluate("document.querySelector('.personalization-card.selected [data-definition-id]')?.getAttribute('data-definition-id') ?? ''")
    require(isinstance(definition_id, str) and definition_id.startswith("user:"),
            f"New definition did not expose a user ID: {definition_id}")
    return definition_id


def open_definition(instance: dict[str, Any], kind_index: int, definition_id: str) -> dict[str, Any]:
    cdp = instance["cdp"]
    open_personalization_kind(instance, kind_index)
    selector = f'[data-definition-id={js(definition_id)}]'
    layout.wait_for(cdp, f"document.querySelector({js(selector)})", timeout=30)
    visual.scroll_to(cdp, selector)
    hit = layout.physical_click(cdp, selector)
    layout.wait_for(cdp, f"document.querySelector('.personalization-editor code')?.textContent?.trim() === {js(definition_id)}", timeout=20)
    return hit


def mark_direct_editor_control(cdp, ordinal: int, control: str, attribute: str) -> str:
    return mark_element(
        cdp,
        f"[...(document.querySelector('.personalization-editor')?.children ?? [])]"
        f".filter((item) => item.tagName === 'LABEL')[{ordinal}]?.querySelector({js(control)})",
        attribute,
    )


def edit_common_fields(cdp, name: str, description: str) -> None:
    name_selector = mark_direct_editor_control(cdp, 0, "input", "data-runtime-definition-name")
    description_selector = mark_direct_editor_control(cdp, 1, "textarea", "data-runtime-definition-description")
    visual.type_text(cdp, name_selector, name, replace=True)
    visual.type_text(cdp, description_selector, description, replace=True)


def mark_reference_checkbox(cdp, definition_name: str, attribute: str) -> str:
    return mark_element(
        cdp,
        "[...document.querySelectorAll('.personalization-editor .personalization-reference-picker label')]"
        f".find((label) => label.textContent?.includes({js(definition_name)}))?.querySelector('input[type=checkbox]')",
        attribute,
    )


def save_editor_physically(cdp) -> int:
    before_text = cdp.evaluate("document.querySelector('.personalization-revision')?.textContent?.trim() ?? ''")
    before_match = re.fullmatch(r"r(\d+)", str(before_text))
    require(before_match is not None, f"Could not read definition revision before save: {before_text}")
    before = int(before_match.group(1))
    selector = mark_element(
        cdp,
        "document.querySelector('.personalization-editor__header-actions .btn-primary')",
        "data-runtime-save-definition",
    )
    visual.scroll_to(cdp, selector, "nearest")
    layout.physical_click(cdp, selector)
    layout.wait_for(cdp, f"document.querySelector('.personalization-revision')?.textContent?.trim() === 'r{before + 1}'", timeout=30)
    return before + 1


def copy_provider_state(source_profile: pathlib.Path, profile: pathlib.Path) -> dict[str, Any]:
    source_config = source_profile / CONFIG_RELATIVE_PATH
    source_state = source_profile / SAFE_STORAGE_STATE_RELATIVE_PATH
    require(source_config.is_file(), f"Encrypted provider config is missing: {source_config}")
    require(source_state.is_file(), f"safeStorage Local State is missing: {source_state}")

    source_hashes = {
        "providerConfig": sha256_file(source_config),
        "localState": sha256_file(source_state),
    }
    target_config = profile / CONFIG_RELATIVE_PATH
    target_state = profile / SAFE_STORAGE_STATE_RELATIVE_PATH
    target_config.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_config, target_config)
    shutil.copy2(source_state, target_state)
    require(sha256_file(target_config) == source_hashes["providerConfig"], "Provider config copy changed bytes")
    require(sha256_file(target_state) == source_hashes["localState"], "Local State copy changed bytes")
    return {
        "sourceProfile": str(source_profile),
        "providerConfigBytes": source_config.stat().st_size,
        "localStateBytes": source_state.stat().st_size,
        "sourceHashes": source_hashes,
    }


def wait_for_provider(cdp) -> dict[str, Any]:
    deadline = time.monotonic() + 90
    last: Any = None
    while time.monotonic() < deadline:
        last = cdp.evaluate("""
        (async () => {
          const settings = await window.metis.getSettings();
          const status = await window.metis.agentStatus();
          return {
            configured: settings?.configured === true,
            hasApiKey: settings?.hasApiKey === true,
            needsReauth: settings?.needsReauth === true,
            provider: status?.provider,
            agentLoopReady: status?.agentLoopReady === true,
            model: settings?.model ?? null,
          };
        })()
        """, await_promise=True)
        if isinstance(last, dict) and last.get("configured") and last.get("hasApiKey") \
                and not last.get("needsReauth") and last.get("provider") == "ready" \
                and last.get("agentLoopReady"):
            return last
        time.sleep(0.5)
    raise AssertionError(f"Configured provider did not become ready: {last}")


def author_personalization_through_ui(
    instance: dict[str, Any],
    output_dir: pathlib.Path,
    skill_marker: str,
    rules_marker: str,
) -> dict[str, Any]:
    cdp = instance["cdp"]
    layout.set_viewport(cdp, 1440, 900)

    skill_id = create_definition_physically(instance, 2)
    edit_common_fields(cdp, "LIVE Runtime Skill", "Real-provider prompt-layer acceptance skill.")
    markdown_selector = mark_element(
        cdp,
        "document.querySelector('.personalization-editor textarea[rows=\"16\"]')",
        "data-runtime-skill-markdown",
    )
    skill_markdown = (
        "# LIVE Runtime Skill\n\n"
        "MANDATORY: Begin the primary deliverable with this exact marker on its own line:\n\n"
        f"{skill_marker}\n\n"
        "Omitting or altering that marker fails the task. "
        "Then create complete, non-placeholder research artifacts."
    )
    visual.type_text(cdp, markdown_selector, skill_markdown, replace=True)
    system_prompt = cdp.evaluate(
        "document.querySelector('.personalization-editor textarea[rows=\"8\"]')?.value ?? null"
    )
    require(system_prompt == "", "Skill marker must exist only in Markdown; system instructions are not empty")
    skill_turns = mark_element(
        cdp,
        "document.querySelector('.personalization-editor input[type=number][min=\"1\"][max=\"100\"]')",
        "data-runtime-skill-turns",
    )
    replace_bounded_number_physically(cdp, skill_turns, 6)
    skill_revision = save_editor_physically(cdp)

    agent_id = create_definition_physically(instance, 1)
    edit_common_fields(cdp, "LIVE Runtime Agent", "Real-provider personalization acceptance agent.")
    role_selector = mark_direct_editor_control(cdp, 3, "input", "data-runtime-agent-role")
    instructions_selector = mark_element(
        cdp,
        "document.querySelector('.personalization-editor textarea[rows=\"14\"]')",
        "data-runtime-agent-instructions",
    )
    visual.type_text(cdp, role_selector, "Research artifact author", replace=True)
    visual.type_text(
        cdp,
        instructions_selector,
        "Produce complete content, never template placeholders. Follow the runtime output contract exactly.",
        replace=True,
    )
    skill_checkbox = mark_reference_checkbox(cdp, "LIVE Runtime Skill", "data-runtime-agent-skill")
    visual.scroll_to(cdp, skill_checkbox)
    layout.physical_click(cdp, skill_checkbox)
    layout.wait_for(cdp, f"document.querySelector({js(skill_checkbox)})?.checked === true", timeout=10)
    agent_turns = mark_element(
        cdp,
        "document.querySelector('.personalization-editor .personalization-grid--3 input[type=number][min=\"1\"]')",
        "data-runtime-agent-turns",
    )
    retry_limit = mark_element(
        cdp,
        "document.querySelector('.personalization-editor .personalization-grid--3 input[type=number][min=\"0\"]')",
        "data-runtime-agent-retry",
    )
    replace_bounded_number_physically(cdp, agent_turns, 6)
    replace_bounded_number_physically(cdp, retry_limit, 2)
    agent_revision = save_editor_physically(cdp)

    scenario_id = create_definition_physically(instance, 0)
    edit_common_fields(cdp, "LIVE Runtime Scenario", "Zero-preset real-provider artifact acceptance.")
    agent_checkbox = mark_reference_checkbox(cdp, "LIVE Runtime Agent", "data-runtime-scenario-agent")
    skill_checkbox = mark_reference_checkbox(cdp, "LIVE Runtime Skill", "data-runtime-scenario-skill")
    for selector in (agent_checkbox, skill_checkbox):
        visual.scroll_to(cdp, selector)
        layout.physical_click(cdp, selector)
        layout.wait_for(cdp, f"document.querySelector({js(selector)})?.checked === true", timeout=10)
    primary_selector = mark_element(
        cdp,
        "document.querySelector('.personalization-editor .personalization-output-plan input')",
        "data-runtime-output-primary",
    )
    visual.type_text(cdp, primary_selector, PRIMARY_NAME, replace=True)
    supporting_selector = mark_element(
        cdp,
        "document.querySelectorAll('.personalization-editor .personalization-output-plan textarea')[0]",
        "data-runtime-output-supporting",
    )
    quality_selector = mark_element(
        cdp,
        "document.querySelectorAll('.personalization-editor .personalization-output-plan textarea')[1]",
        "data-runtime-output-quality",
    )
    layout.wait_for(cdp, f"document.querySelector({js(supporting_selector)})?.disabled === false", timeout=10)
    visual.type_text(cdp, supporting_selector, SUPPORTING_NAME, replace=True)
    visual.type_text(cdp, quality_selector, QUALITY_NAME, replace=True)
    workflow_count = cdp.evaluate("document.querySelectorAll('.personalization-editor .personalization-step').length")
    require(workflow_count == 0, f"Scenario unexpectedly gained authored workflow steps: {workflow_count}")
    scenario_revision = save_editor_physically(cdp)

    rules_id = create_definition_physically(instance, 4)
    edit_common_fields(cdp, "LIVE Scenario Metis.md", "Scenario-scoped real-provider acceptance rules.")
    scope_selector = mark_element(
        cdp,
        "document.querySelectorAll('.personalization-editor .personalization-grid--2 select')[0]",
        "data-runtime-rules-scope",
    )
    select_value_physically(cdp, scope_selector, "scenario")
    bound_selector = mark_element(
        cdp,
        "document.querySelectorAll('.personalization-editor .personalization-grid--2 select')[1]",
        "data-runtime-rules-scenario",
    )
    select_value_physically(cdp, bound_selector, scenario_id)
    rules_selector = mark_element(
        cdp,
        "document.querySelector('.personalization-editor textarea[rows=\"20\"]')",
        "data-runtime-rules-markdown",
    )
    visual.type_text(
        cdp,
        rules_selector,
        f"# Metis.md\n\nThe primary deliverable must contain the exact marker {rules_marker}.",
        replace=True,
    )
    rules_revision = save_editor_physically(cdp)

    open_definition(instance, 0, scenario_id)
    rules_checkbox = mark_reference_checkbox(cdp, "LIVE Scenario Metis.md", "data-runtime-scenario-rules")
    visual.scroll_to(cdp, rules_checkbox)
    layout.physical_click(cdp, rules_checkbox)
    layout.wait_for(cdp, f"document.querySelector({js(rules_checkbox)})?.checked === true", timeout=10)
    require(cdp.evaluate("document.querySelectorAll('.personalization-editor .personalization-step').length") == 0,
            "Binding Metis.md created a hidden authored workflow step")
    scenario_revision = save_editor_physically(cdp)

    authored = cdp.evaluate(f"""
    (async () => {{
      const response = await window.metis.listPersonalization({{
        contractVersion: 1, includeDisabled: true,
      }});
      if (!response?.ok) return {{ ok: false }};
      const byId = new Map(response.definitions.map((item) => [item.id, item]));
      const skill = byId.get({js(skill_id)});
      const agent = byId.get({js(agent_id)});
      const rules = byId.get({js(rules_id)});
      const scenario = byId.get({js(scenario_id)});
      return {{
        ok: true,
        skill: {{
          revision: skill?.revision,
          markdownMarker: skill?.markdown?.includes({js(skill_marker)}),
          systemPromptMirrorsMarkdown: skill?.systemPrompt === skill?.markdown,
        }},
        agent: {{ revision: agent?.revision, skillBound: agent?.skillIds?.includes({js(skill_id)}) }},
        rules: {{ revision: rules?.revision, scope: rules?.scope, scopeId: rules?.scopeId, marker: rules?.markdown?.includes({js(rules_marker)}) }},
        scenario: {{
          revision: scenario?.revision,
          agentBound: scenario?.agentIds?.includes({js(agent_id)}),
          skillBound: scenario?.skillIds?.includes({js(skill_id)}),
          rulesBound: scenario?.rulesIds?.includes({js(rules_id)}),
          workflowCount: scenario?.workflow?.length,
          plan: scenario?.output?.plan,
        }},
      }};
    }})()
    """, await_promise=True)
    require(isinstance(authored, dict) and authored.get("ok") is True, "UI-authored definitions could not be read back")
    require(authored.get("skill") == {
        "revision": skill_revision, "markdownMarker": True, "systemPromptMirrorsMarkdown": True,
    }, f"UI-authored Skill differs from the editor state: {authored.get('skill')}")
    require(authored.get("agent") == {
        "revision": agent_revision, "skillBound": True,
    }, f"UI-authored Agent differs from the editor state: {authored.get('agent')}")
    require(authored.get("rules") == {
        "revision": rules_revision, "scope": "scenario", "scopeId": scenario_id, "marker": True,
    }, f"UI-authored Metis.md differs from the editor state: {authored.get('rules')}")
    scenario_state = authored.get("scenario") if isinstance(authored.get("scenario"), dict) else {}
    require(scenario_state.get("revision") == scenario_revision
            and scenario_state.get("agentBound") is True
            and scenario_state.get("skillBound") is True
            and scenario_state.get("rulesBound") is True
            and scenario_state.get("workflowCount") == 0,
            f"UI-authored Scenario bindings are incomplete: {scenario_state}")
    require(scenario_state.get("plan") == {
        "primaryDeliverable": PRIMARY_NAME,
        "supportingArtifacts": [SUPPORTING_NAME],
        "qualityCriteria": [QUALITY_NAME],
    }, f"UI-authored output plan differs from the editor state: {scenario_state.get('plan')}")
    return {
        "skillId": skill_id,
        "agentId": agent_id,
        "rulesId": rules_id,
        "scenarioId": scenario_id,
        "revisions": {
            "skill": skill_revision,
            "agent": agent_revision,
            "rules": rules_revision,
            "scenario": scenario_revision,
        },
        "workflowCount": 0,
        "outputPlan": {
            "primary": PRIMARY_NAME,
            "supportingCount": 1,
            "qualityCount": 1,
        },
    }


def capture_personalization_viewports(
    instance: dict[str, Any],
    output_dir: pathlib.Path,
    scenario_id: str,
) -> list[dict[str, Any]]:
    cdp = instance["cdp"]
    evidence: list[dict[str, Any]] = []
    for width in (1440, 650, 400):
        layout.set_viewport(cdp, width, 900)
        hit = open_definition(instance, 0, scenario_id)
        screenshot = output_dir / f"phase-1-personalization-{width}x900.png"
        layout.capture(cdp, screenshot)
        geometry = cdp.evaluate("""
        (() => ({
          viewportWidth: window.innerWidth,
          documentScrollWidth: document.documentElement.scrollWidth,
          pageScrollWidth: document.querySelector('.personalization-page')?.scrollWidth ?? 0,
          pageClientWidth: document.querySelector('.personalization-page')?.clientWidth ?? 0,
        }))()
        """)
        require(isinstance(geometry, dict), f"Viewport geometry is unavailable at {width}px")
        require(int(geometry.get("documentScrollWidth", width)) <= width + 1,
                f"Personalization document overflows horizontally at {width}px: {geometry}")
        page_width = int(geometry.get("pageClientWidth", 0))
        require(page_width > 0 and int(geometry.get("pageScrollWidth", page_width)) <= page_width + 1,
                f"Personalization page overflows horizontally at {width}px: {geometry}")
        evidence.append({
            "width": width,
            "height": 900,
            "screenshot": str(screenshot),
            "clickHit": hit,
            "geometry": geometry,
        })
    layout.set_viewport(cdp, 1440, 900)
    open_definition(instance, 0, scenario_id)
    return evidence


def list_session_ids(cdp) -> list[str]:
    payload = cdp.evaluate("window.metis.listSessions()", await_promise=True)
    require(isinstance(payload, dict) and payload.get("success") is True,
            f"Session list is unavailable: {payload}")
    sessions = payload.get("sessions")
    require(isinstance(sessions, list), "Session list has an invalid shape")
    return [str(item.get("id")) for item in sessions if isinstance(item, dict) and item.get("id")]


def use_scenario_and_send_physically(
    instance: dict[str, Any],
    output_dir: pathlib.Path,
    scenario_id: str,
    sentinel: str,
    skill_marker: str,
    rules_marker: str,
) -> dict[str, Any]:
    cdp = instance["cdp"]
    layout.set_viewport(cdp, 1440, 900)
    open_definition(instance, 0, scenario_id)
    sessions_before = set(list_session_ids(cdp))
    use_selector = mark_element(
        cdp,
        f"document.querySelector({js(f'[data-definition-id={js(scenario_id)}]')})"
        "?.closest('.personalization-card')?.querySelector('.personalization-card__actions button:not(:disabled)')",
        "data-runtime-use-scenario",
    )
    visual.scroll_to(cdp, use_selector)
    use_hit = layout.physical_click(cdp, use_selector)
    layout.wait_for(cdp, "document.querySelector('.chat-main')", timeout=30)

    new_session_selector = mark_element(
        cdp,
        "document.querySelector('.chat-sidebar-header .btn-primary')",
        "data-runtime-new-session",
    )
    visual.scroll_to(cdp, new_session_selector, "nearest")
    session_hit = layout.physical_click(cdp, new_session_selector)
    deadline = time.monotonic() + 30
    session_id = ""
    while time.monotonic() < deadline:
        current = set(list_session_ids(cdp))
        created = sorted(current - sessions_before)
        if len(created) == 1:
            session_id = created[0]
            break
        time.sleep(0.2)
    require(bool(session_id), "Physical New session did not create exactly one session")
    layout.wait_for(
        cdp,
        f"document.querySelector('[data-testid=\"chat-scenario-controls\"] select')?.value === {js(scenario_id)}",
        timeout=30,
    )
    prompt = (
        "Create a concise research note. The primary deliverable must contain this exact "
        f"verification marker: {sentinel}. The supporting artifact and quality evidence "
        "must explain where the marker appears. Follow the required output bundle exactly. "
        "Obey every bound Skill and Metis.md instruction exactly, including each mandatory "
        "marker defined by those layers."
    )
    visual.type_text(cdp, ".chat-textarea", prompt, replace=True)
    send_hit = layout.physical_click(cdp, ".chat-send")
    marker_expression = " && ".join(
        f"body.includes({js(marker)})" for marker in (sentinel, skill_marker, rules_marker)
    )
    layout.wait_for(cdp, f"""
    (() => {{
      const body = [...document.querySelectorAll('.chat-messages .message-content')]
        .map((item) => item.textContent ?? '').join('\\n');
      return {marker_expression};
    }})()
    """, timeout=360)
    screenshot = output_dir / "phase-1-chat-completed-1440x900.png"
    layout.capture(cdp, screenshot)
    return {
        "sessionId": session_id,
        "promptChars": len(prompt),
        "promptSha256": sha256_text(prompt),
        "screenshot": str(screenshot),
        "useScenarioClick": use_hit,
        "newSessionClick": session_hit,
        "sendClick": send_hit,
    }


def runtime_readback_expression(
    session_id: str,
    agent_id: str,
    skill_id: str,
    rules_id: str,
    scenario_id: str,
) -> str:
    return f"""
    (async () => {{
      const api = window.metis;
      const definitions = await api.listPersonalization({{
        contractVersion: 1, includeDisabled: true,
      }});
      const resolved = await api.resolvePersonalization({{
        contractVersion: 1, sessionId: {js(session_id)}, projectId: 'global', scenarioId: {js(scenario_id)},
      }});
      const messages = await api.getMessages({js(session_id)});
      const artifacts = await api.listArtifacts({js(session_id)});
      const contents = [];
      if (artifacts?.success) {{
        for (const item of artifacts.items) {{
          contents.push(await api.getArtifactContent({js(session_id)}, item.id));
        }}
      }}
      const assistant = [...(Array.isArray(messages) ? messages : [])]
        .reverse().find((item) => item?.role === 'assistant' && typeof item?.content === 'string');
      return {{
        definitions: {{
          ok: definitions?.ok,
          hasAgent: definitions?.definitions?.some((item) => item.id === {js(agent_id)}) === true,
          hasSkill: definitions?.definitions?.some((item) => item.id === {js(skill_id)}) === true,
          hasRules: definitions?.definitions?.some((item) => item.id === {js(rules_id)}) === true,
          hasScenario: definitions?.definitions?.some((item) => item.id === {js(scenario_id)}) === true,
        }},
        resolved,
        messages,
        chat: {{ status: assistant ? 'completed' : 'missing', answer: assistant?.content ?? '' }},
        artifacts,
        contents,
      }};
    }})()
    """


def phase_two_expression(
    session_id: str,
    agent_id: str,
    skill_id: str,
    rules_id: str,
    scenario_id: str,
) -> str:
    return f"""
    (async () => {{
      const api = window.metis;
      const definitions = await api.listPersonalization({{
        contractVersion: 1, includeDisabled: true,
      }});
      const artifacts = await api.listArtifacts({js(session_id)});
      const contents = [];
      if (artifacts?.success) {{
        for (const item of artifacts.items) {{
          contents.push(await api.getArtifactContent({js(session_id)}, item.id));
        }}
      }}
      const messages = await api.getMessages({js(session_id)});
      const resolved = await api.resolvePersonalization({{
        contractVersion: 1, sessionId: {js(session_id)}, projectId: 'global', scenarioId: {js(scenario_id)},
      }});
      return {{
        definitions: {{
          ok: definitions?.ok,
          hasAgent: definitions?.definitions?.some((item) => item.id === {js(agent_id)}) === true,
          hasSkill: definitions?.definitions?.some((item) => item.id === {js(skill_id)}) === true,
          hasRules: definitions?.definitions?.some((item) => item.id === {js(rules_id)}) === true,
          hasScenario: definitions?.definitions?.some((item) => item.id === {js(scenario_id)}) === true,
        }},
        artifacts, contents, messages, resolved,
      }};
    }})()
    """


def validate_resolution(
    resolved: Any,
    agent_id: str,
    skill_id: str,
    rules_id: str,
    scenario_id: str,
) -> None:
    require(isinstance(resolved, dict) and resolved.get("ok") is True, f"Scenario resolve failed: {resolved}")
    manifest = resolved.get("manifest")
    require(isinstance(manifest, dict), "Resolved manifest is missing")
    revisions = manifest.get("definitionRevisions")
    require(isinstance(revisions, dict), "Resolved definition revisions are missing")
    require(all(isinstance(revisions.get(definition_id), int) and revisions.get(definition_id) >= 1
                for definition_id in [agent_id, skill_id, rules_id, scenario_id]),
            f"Resolved manifest omitted a bound definition: {revisions}")
    require(agent_id in manifest.get("agentIds", []), "Resolved manifest omitted the user Agent")
    require(skill_id in manifest.get("skillIds", []), "Resolved manifest omitted the user Skill")
    layers = manifest.get("promptStack")
    require(isinstance(layers, list), "Resolved prompt stack is missing")
    layer_index = {(layer.get("sourceId"), layer.get("sourceKind"), layer.get("precedence")) for layer in layers}
    require((skill_id, "skill", 100) in layer_index, "User Skill did not enter the prompt stack")
    require((agent_id, "agent", 200) in layer_index, "User Agent did not enter the prompt stack")
    require((rules_id, "rules", 400) in layer_index, "Scenario Metis.md did not enter the prompt stack")
    require(manifest.get("workflow") == [], "Authored empty workflow was not preserved in the resolved preview")
    implicit_step = manifest.get("implicitOutputStep")
    require(isinstance(implicit_step, dict), "Resolved output-plan scenario omitted its runtime-only step")
    require(implicit_step.get("id") == "runtime-output-plan"
            and implicit_step.get("agentId") == agent_id
            and skill_id in implicit_step.get("skillIds", []),
            f"Runtime-only output step lost Agent or Skill bindings: {implicit_step}")


def validate_runtime_result(
    result: dict[str, Any],
    sentinel: str,
    skill_marker: str,
    rules_marker: str,
    agent_id: str,
    skill_id: str,
    rules_id: str,
    scenario_id: str,
) -> dict[str, Any]:
    definitions = result.get("definitions") if isinstance(result.get("definitions"), dict) else {}
    require(definitions.get("ok") is True
            and all(definitions.get(name) is True for name in ("hasAgent", "hasSkill", "hasRules", "hasScenario")),
            f"UI-authored definition readback is incomplete: {definitions}")
    validate_resolution(result.get("resolved"), agent_id, skill_id, rules_id, scenario_id)
    chat = result.get("chat", {})
    require(chat.get("status") == "completed", f"Scenario chat did not complete: {chat.get('status')}")
    answer = chat.get("answer")
    require(isinstance(answer, str) and sentinel in answer, "Primary answer did not contain the exact user sentinel")
    require(skill_marker in answer, "Primary answer did not contain the Skill-only marker")
    require(rules_marker in answer, "Primary answer did not contain the scenario Metis.md marker")
    artifact_evidence = validate_artifacts(result.get("artifacts"), result.get("contents"), sentinel)
    primary = next(row for row in artifact_evidence["items"] if row["name"] == "LIVE Personalization Report.md")
    answer_digest = sha256_text(answer)
    require(answer_digest == primary["contentSha256"], "Assistant answer differs from persisted primary artifact")
    return {
        **artifact_evidence,
        "answerChars": len(answer),
        "answerSha256": answer_digest,
        "answerMatchesPrimaryArtifact": True,
    }


def observe_runtime_result(
    result: dict[str, Any],
    sentinel: str,
    skill_marker: str,
    rules_marker: str,
) -> dict[str, Any]:
    """Record non-secret diagnostics before fail-closed marker assertions run."""
    markers = {
        "user": sentinel,
        "skill": skill_marker,
        "rules": rules_marker,
    }
    chat = result.get("chat") if isinstance(result.get("chat"), dict) else {}
    answer = chat.get("answer") if isinstance(chat.get("answer"), str) else ""
    resolved = result.get("resolved") if isinstance(result.get("resolved"), dict) else {}
    manifest = resolved.get("manifest") if isinstance(resolved.get("manifest"), dict) else {}
    layers = manifest.get("promptStack") if isinstance(manifest.get("promptStack"), list) else []
    contents = result.get("contents") if isinstance(result.get("contents"), list) else []
    return {
        "chatStatus": chat.get("status"),
        "answerChars": len(answer),
        "answerSha256": sha256_text(answer),
        "answerContains": {name: marker in answer for name, marker in markers.items()},
        "promptLayers": [
            {
                "sourceId": layer.get("sourceId"),
                "sourceKind": layer.get("sourceKind"),
                "precedence": layer.get("precedence"),
                "contentContains": {
                    name: marker in str(layer.get("content", ""))
                    for name, marker in markers.items()
                },
            }
            for layer in layers
            if isinstance(layer, dict)
        ],
        "artifactContents": [
            {
                "id": row.get("id"),
                "success": row.get("success"),
                "contentChars": len(row.get("content", "")) if isinstance(row.get("content"), str) else 0,
                "contentSha256": sha256_text(row.get("content", "")) if isinstance(row.get("content"), str) else None,
                "contentContains": {
                    name: marker in str(row.get("content", ""))
                    for name, marker in markers.items()
                },
            }
            for row in contents
            if isinstance(row, dict)
        ],
    }


def validate_artifacts(artifacts: Any, contents: Any, sentinel: str) -> dict[str, Any]:
    require(isinstance(artifacts, dict) and artifacts.get("success") is True, f"Artifact list failed: {artifacts}")
    items = artifacts.get("items")
    require(isinstance(items, list) and len(items) == 3, f"Expected 3 generated artifacts, got: {items}")
    require(all(item.get("contentAvailable") is True for item in items), "Generated artifact content is unavailable")
    content_rows = contents if isinstance(contents, list) else []
    require(len(content_rows) == len(items), "Artifact content response count differs from artifact list")
    by_id = {row.get("id"): row for row in content_rows if isinstance(row, dict) and row.get("success") is True}
    require(len(by_id) == len(items), "One or more artifact bodies could not be read")
    evidence: list[dict[str, Any]] = []
    for item in items:
        body = by_id[item["id"]].get("content")
        require(isinstance(body, str) and body.strip(), f"Artifact body is empty: {item.get('name')}")
        evidence.append({
            "id": item["id"],
            "name": item["name"],
            "contentChars": len(body),
            "contentSha256": sha256_text(body),
            "containsSentinel": sentinel in body,
        })
    require(any(row["name"] == "LIVE Personalization Report.md" and row["containsSentinel"] for row in evidence),
            "Primary generated artifact did not contain the exact sentinel")
    return {"count": len(evidence), "items": sorted(evidence, key=lambda row: row["id"])}


def open_primary_artifact(instance: dict[str, Any], output_dir: pathlib.Path, phase: str) -> dict[str, Any]:
    cdp = instance["cdp"]
    layout.set_viewport(cdp, 1440, 900)
    cdp.call("Page.reload", {"ignoreCache": True})
    layout.wait_for(cdp, "document.querySelector('.project-shell') && !document.querySelector('.hydration-loading')", timeout=45)
    layout.wait_for(cdp, "document.querySelector('.right-panel-tabs button:nth-child(2)')", timeout=30)
    tab_hit = layout.physical_click(cdp, ".right-panel-tabs button:nth-child(2)")
    layout.wait_for(cdp, "document.querySelector('.artifact-item:not(:disabled)')", timeout=30)
    marked = cdp.evaluate("""
    (() => {
      const button = [...document.querySelectorAll('.artifact-item')]
        .find((candidate) => candidate.getAttribute('aria-label') === 'LIVE Personalization Report.md');
      if (!button) return false;
      button.setAttribute('data-runtime-primary-artifact', 'true');
      return true;
    })()
    """)
    require(marked is True, "Primary artifact button is missing after renderer reload")
    artifact_hit = layout.physical_click(cdp, '[data-runtime-primary-artifact="true"]')
    layout.wait_for(cdp, "document.querySelector('.artifact-preview-title')?.textContent?.includes('LIVE Personalization Report')", timeout=30)
    screenshot = output_dir / f"{phase}-artifact-open.png"
    layout.capture(cdp, screenshot)
    preview = cdp.evaluate("""
    (() => ({
      title: document.querySelector('.artifact-preview-title')?.textContent?.trim() ?? '',
      bodyChars: document.querySelector('.artifact-preview-body')?.textContent?.length ?? 0,
      buttonEnabled: !document.querySelector('[data-runtime-primary-artifact="true"]')?.disabled,
    }))()
    """)
    require(isinstance(preview, dict) and preview.get("bodyChars", 0) > 0 and preview.get("buttonEnabled") is True,
            f"Artifact preview did not open: {preview}")
    return {
        **preview,
        "screenshot": str(screenshot),
        "artifactTabClick": tab_hit,
        "artifactClick": artifact_hit,
    }


def stop_app_gracefully(instance: dict[str, Any], output_dir: pathlib.Path) -> None:
    """Close Electron normally so Chromium can flush durable renderer storage."""
    process = instance["process"]
    browser_cdp = None
    close_error: Exception | None = None
    try:
        browser_target = layout.wait_for_browser_target(instance["port"], timeout=10)
        browser_cdp = layout.CDP(
            browser_target,
            instance["port"],
            output_dir / f"cdp-{instance['phase']}-browser-close.ndjson",
            call_timeout=10,
        )
        try:
            browser_cdp.call("Browser.close", timeout=10)
        except Exception as error:
            close_error = error
    finally:
        if browser_cdp is not None:
            try:
                browser_cdp.close()
            except Exception:
                pass
        try:
            instance["cdp"].close()
        except Exception:
            pass

    try:
        process.wait(timeout=30)
    except subprocess.TimeoutExpired as error:
        launcher.terminate_process_tree(process)
        instance["logHandle"].close()
        raise AssertionError("Electron did not exit after Browser.close") from error
    instance["logHandle"].close()
    require(process.returncode == 0, f"Electron graceful exit returned {process.returncode}: {close_error}")


def open_agent_editor(instance: dict[str, Any], agent_id: str) -> None:
    cdp = instance["cdp"]
    layout.physical_click(cdp, '[data-testid="personalization-trigger"]')
    layout.wait_for(cdp, "document.querySelector('.personalization-page')", timeout=30)
    marked_tab = cdp.evaluate("""
    (() => {
      const tab = document.querySelectorAll('.personalization-tabs button')[1];
      if (!tab) return false;
      tab.setAttribute('data-runtime-agents-tab', 'true');
      return true;
    })()
    """)
    require(marked_tab is True, "Agents tab is missing from Personalization")
    layout.physical_click(cdp, '[data-runtime-agents-tab="true"]')
    card_selector = f'[data-definition-id={js(agent_id)}]'
    layout.wait_for(cdp, f"document.querySelector({js(card_selector)})", timeout=30)
    layout.physical_click(cdp, card_selector)
    layout.wait_for(cdp, "document.querySelector('.personalization-editor')", timeout=30)
    marked_editor = cdp.evaluate("""
    (() => {
      const label = [...document.querySelectorAll('.personalization-editor label')]
        .find((candidate) => ['Description', '说明'].includes(candidate.querySelector(':scope > span')?.textContent?.trim()));
      const textarea = label?.querySelector('textarea');
      if (!textarea) return false;
      textarea.setAttribute('data-runtime-agent-description', 'true');
      return true;
    })()
    """)
    require(marked_editor is True, "Agent description editor is missing")


def stage_unsaved_draft(
    instance: dict[str, Any],
    output_dir: pathlib.Path,
    agent_id: str,
    draft_text: str,
) -> dict[str, Any]:
    open_agent_editor(instance, agent_id)
    cdp = instance["cdp"]
    visual.type_text(cdp, '[data-runtime-agent-description="true"]', draft_text, replace=True)
    draft_key = f"metis:personalization-draft:v1:{agent_id}"
    layout.wait_for(
        cdp,
        f"window.localStorage.getItem({js(draft_key)})?.includes({js(draft_text)}) === true",
        timeout=15,
    )
    screenshot = output_dir / "phase-1-unsaved-draft.png"
    layout.capture(cdp, screenshot)
    return {
        "draftChars": len(draft_text),
        "draftSha256": sha256_text(draft_text),
        "localStoragePresent": True,
        "screenshot": str(screenshot),
    }


def verify_unsaved_draft_after_restart(
    instance: dict[str, Any],
    output_dir: pathlib.Path,
    agent_id: str,
    draft_text: str,
) -> dict[str, Any]:
    open_agent_editor(instance, agent_id)
    cdp = instance["cdp"]
    layout.wait_for(
        cdp,
        f"document.querySelector('[data-runtime-agent-description=\"true\"]')?.value === {js(draft_text)}",
        timeout=15,
    )
    notice = cdp.evaluate("document.querySelector('.personalization-draft-notice')?.textContent?.trim() ?? ''")
    require(isinstance(notice, str) and len(notice) > 0, "Restarted editor did not announce the restored draft")
    screenshot = output_dir / "phase-2-restart-unsaved-draft.png"
    layout.capture(cdp, screenshot)
    return {
        "draftChars": len(draft_text),
        "draftSha256": sha256_text(draft_text),
        "restoredNotice": notice,
        "screenshot": str(screenshot),
    }


def sqlite_evidence(
    profile: pathlib.Path,
    session_id: str,
    agent_id: str,
    skill_id: str,
    rules_id: str,
    scenario_id: str,
) -> dict[str, Any]:
    database = profile / DATABASE_RELATIVE_PATH
    require(database.is_file(), "SQLite database is missing after Electron shutdown")
    connection = sqlite3.connect(database)
    try:
        definitions = connection.execute(
            "SELECT id, kind, current_revision FROM personalization_definitions WHERE id IN (?, ?, ?, ?) ORDER BY id",
            (agent_id, skill_id, rules_id, scenario_id),
        ).fetchall()
        run_rows = connection.execute(
            "SELECT status, record_json FROM personalization_scenario_runs WHERE session_id = ? ORDER BY run_id",
            (session_id,),
        ).fetchall()
        artifact_rows = connection.execute(
            "SELECT id, name, content, metadata FROM artifacts WHERE session_id = ? ORDER BY id",
            (session_id,),
        ).fetchall()
        message_count = connection.execute(
            "SELECT COUNT(*) FROM messages WHERE session_id = ?",
            (session_id,),
        ).fetchone()[0]
    finally:
        connection.close()
    run_evidence: list[dict[str, Any]] = []
    for status, record_json in run_rows:
        record = json.loads(record_json)
        artifact_ref_count = sum(len(step.get("artifactRefs", [])) for step in record.get("steps", []))
        snapshot = record.get("manifestSnapshot") if isinstance(record.get("manifestSnapshot"), dict) else {}
        run_evidence.append({
            "status": status,
            "artifactRefCount": artifact_ref_count,
            "manifestDigest": record.get("manifestDigest"),
            "workflowCount": len(snapshot.get("workflow", [])) if isinstance(snapshot.get("workflow"), list) else -1,
            "stepIds": [step.get("stepId") for step in record.get("steps", []) if isinstance(step, dict)],
        })
    artifact_evidence = []
    for row in artifact_rows:
        metadata = json.loads(row[3]) if isinstance(row[3], str) else {}
        artifact_evidence.append({
            "id": row[0],
            "name": row[1],
            "contentChars": len(row[2]),
            "contentSha256": sha256_text(row[2]),
            "manifestDigest": metadata.get("manifestDigest"),
        })
    return {
        "databaseBytes": database.stat().st_size,
        "definitions": [{"id": row[0], "kind": row[1], "revision": row[2]} for row in definitions],
        "scenarioRuns": run_evidence,
        "messageCount": message_count,
        "artifacts": artifact_evidence,
    }


def run(source_profile: pathlib.Path, output_dir: pathlib.Path, keep_profile: bool) -> tuple[dict[str, Any], int]:
    source_profile = source_profile.resolve()
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=False)
    run_started_at = int(time.time() * 1000)
    sgtool_baseline = snapshot_sgtool_processes()
    profile = pathlib.Path(tempfile.mkdtemp(prefix="metis-personalization-runtime-")).resolve()
    marker = f"LIVE-PERSONALIZATION-{int(time.time())}"
    skill_marker = f"LIVE-SKILL-{uuid.uuid4().hex}"
    rules_marker = f"LIVE-RULES-{uuid.uuid4().hex}"
    unsaved_draft = f"LIVE unsaved Agent draft {uuid.uuid4().hex}"
    session_id = ""
    agent_id = ""
    skill_id = ""
    rules_id = ""
    scenario_id = ""
    report: dict[str, Any] = {
        "task": "electron-personalization-runtime-acceptance",
        "status": "running",
        "startedAtUnixMs": run_started_at,
        "sgToolBaseline": [
            {"pid": pid, "startedAtUnixMs": started_at}
            for pid, started_at in sorted(sgtool_baseline.items())
        ],
        "sourceProfile": str(source_profile),
        "isolatedProfile": str(profile),
        "sentinelSha256": sha256_text(marker),
        "skillMarkerSha256": sha256_text(skill_marker),
        "rulesMarkerSha256": sha256_text(rules_marker),
        "unsavedDraftSha256": sha256_text(unsaved_draft),
    }
    active: dict[str, Any] | None = None
    exit_code = 1
    source_evidence: dict[str, Any] | None = None
    try:
        source_evidence = copy_provider_state(source_profile, profile)
        report["encryptedProviderCopy"] = source_evidence

        active = visual.launch_app(profile, output_dir, "phase-1", None, ".project-shell")
        # OpenAICompatProvider permits four 60-second attempts plus exponential
        # backoff. Let the product reach its own success/failure boundary before
        # the CDP harness declares an infrastructure timeout.
        active["cdp"].call_timeout = 360
        report["phase1Health"] = visual.assert_persistence_health(active, True)
        provider = wait_for_provider(active["cdp"])
        report["provider"] = {
            "configured": provider["configured"],
            "hasApiKey": provider["hasApiKey"],
            "needsReauth": provider["needsReauth"],
            "provider": provider["provider"],
            "agentLoopReady": provider["agentLoopReady"],
            "model": provider["model"],
        }
        authoring = author_personalization_through_ui(
            active, output_dir, skill_marker, rules_marker,
        )
        report["uiAuthoring"] = authoring
        agent_id = authoring["agentId"]
        skill_id = authoring["skillId"]
        rules_id = authoring["rulesId"]
        scenario_id = authoring["scenarioId"]
        report.update({
            "agentId": agent_id,
            "skillId": skill_id,
            "rulesId": rules_id,
            "scenarioId": scenario_id,
        })
        report["personalizationViewports"] = capture_personalization_viewports(
            active, output_dir, scenario_id,
        )
        chat_ui = use_scenario_and_send_physically(
            active,
            output_dir,
            scenario_id,
            marker,
            skill_marker,
            rules_marker,
        )
        report["chatPhysicalFlow"] = chat_ui
        session_id = chat_ui["sessionId"]
        report["sessionId"] = session_id
        first_raw = active["cdp"].evaluate(
            runtime_readback_expression(
                session_id,
                agent_id,
                skill_id,
                rules_id,
                scenario_id,
            ),
            await_promise=True,
        )
        require(isinstance(first_raw, dict), "Phase-one bridge result is not an object")
        report["phase1Observed"] = observe_runtime_result(
            first_raw, marker, skill_marker, rules_marker,
        )
        report["phase1Artifacts"] = validate_runtime_result(
            first_raw,
            marker,
            skill_marker,
            rules_marker,
            agent_id,
            skill_id,
            rules_id,
            scenario_id,
        )
        report["phase1Preview"] = open_primary_artifact(active, output_dir, "phase-1")
        report["phase1UnsavedDraft"] = stage_unsaved_draft(
            active, output_dir, agent_id, unsaved_draft,
        )
        stop_app_gracefully(active, output_dir)
        active = None
        report["sqliteAfterPhase1"] = sqlite_evidence(
            profile, session_id, agent_id, skill_id, rules_id, scenario_id,
        )
        require(len(report["sqliteAfterPhase1"]["definitions"]) == 4,
                "SQLite did not persist all four user-created definitions")
        scenario_runs = report["sqliteAfterPhase1"]["scenarioRuns"]
        require(len(scenario_runs) == 1
                and scenario_runs[0].get("status") == "completed"
                and scenario_runs[0].get("artifactRefCount") == 3
                and scenario_runs[0].get("workflowCount") == 1
                and scenario_runs[0].get("stepIds") == ["runtime-output-plan"],
                f"Persisted runtime-only scenario run is incomplete: {scenario_runs}")
        run_digest = scenario_runs[0].get("manifestDigest")
        require(isinstance(run_digest, str) and len(run_digest) == 64,
                f"Scenario run manifest digest is missing: {run_digest}")
        require(all(item.get("manifestDigest") == run_digest
                    for item in report["sqliteAfterPhase1"]["artifacts"]),
                "Generated artifacts do not share the scenario execution manifest digest")

        active = visual.launch_app(profile, output_dir, "phase-2-restart", None, ".project-shell")
        active["cdp"].call_timeout = 120
        report["phase2Health"] = visual.assert_persistence_health(active, True)
        restarted_provider = wait_for_provider(active["cdp"])
        require(restarted_provider.get("agentLoopReady") is True, "Provider did not recover after full restart")
        second_raw = active["cdp"].evaluate(
            phase_two_expression(session_id, agent_id, skill_id, rules_id, scenario_id),
            await_promise=True,
        )
        require(isinstance(second_raw, dict), "Restart bridge result is not an object")
        require(second_raw.get("definitions", {}).get("hasAgent") is True, "Agent definition did not survive restart")
        require(second_raw.get("definitions", {}).get("hasSkill") is True, "Skill definition did not survive restart")
        require(second_raw.get("definitions", {}).get("hasRules") is True, "Scenario Metis.md did not survive restart")
        require(second_raw.get("definitions", {}).get("hasScenario") is True, "Scenario definition did not survive restart")
        validate_resolution(second_raw.get("resolved"), agent_id, skill_id, rules_id, scenario_id)
        report["phase2UnsavedDraft"] = verify_unsaved_draft_after_restart(
            active, output_dir, agent_id, unsaved_draft,
        )
        report["phase2Artifacts"] = validate_artifacts(second_raw.get("artifacts"), second_raw.get("contents"), marker)
        require(report["phase2Artifacts"]["items"] == report["phase1Artifacts"]["items"],
                "Artifact identity/content changed across restart")
        messages = second_raw.get("messages")
        require(isinstance(messages, list) and any(
            isinstance(message, dict)
            and message.get("role") == "assistant"
            and all(token in str(message.get("content", "")) for token in [marker, skill_marker, rules_marker])
            for message in messages
        ), "Persisted assistant message with user, Skill, and Metis.md markers is missing after restart")
        report["phase2Preview"] = open_primary_artifact(active, output_dir, "phase-2-restart")
        stop_app_gracefully(active, output_dir)
        active = None
        report["sqliteAfterRestart"] = sqlite_evidence(
            profile, session_id, agent_id, skill_id, rules_id, scenario_id,
        )
        require(report["sqliteAfterRestart"]["artifacts"] == report["sqliteAfterPhase1"]["artifacts"],
                "SQLite artifact rows changed across restart")
        require(report["sqliteAfterRestart"]["scenarioRuns"] == report["sqliteAfterPhase1"]["scenarioRuns"],
                "Scenario run state changed across restart")

        require(source_evidence["sourceHashes"]["providerConfig"] == sha256_file(source_profile / CONFIG_RELATIVE_PATH),
                "Source provider config changed during acceptance")
        require(source_evidence["sourceHashes"]["localState"] == sha256_file(source_profile / SAFE_STORAGE_STATE_RELATIVE_PATH),
                "Source Local State changed during acceptance")
        report["sourceProfileUnchanged"] = True
        report["status"] = "passed"
        exit_code = 0
    except Exception as error:
        report["status"] = "failed"
        report["error"] = f"{type(error).__name__}: {error}"
        report["traceback"] = traceback.format_exc()
        if active is not None:
            try:
                layout.capture(active["cdp"], output_dir / "failure.png")
            except Exception as capture_error:
                report["captureError"] = f"{type(capture_error).__name__}: {capture_error}"
    finally:
        if active is not None:
            try:
                visual.stop_app(active)
            except Exception as stop_error:
                report["stopError"] = f"{type(stop_error).__name__}: {stop_error}"
                report["status"] = "failed"
                exit_code = 1
        for log_path in output_dir.glob("electron-*.log"):
            sanitize_electron_log(log_path)
        report["finishedAtUnixMs"] = int(time.time() * 1000)
        if keep_profile:
            report["profileRemoved"] = False
        else:
            removed, cleanup_error = launcher.remove_profile(profile, timeout=3)
            report["profileCleanupInitialError"] = cleanup_error
            cleanup_processes: list[dict[str, Any]] = []
            if not removed:
                cleanup_processes = terminate_isolated_sgtool_locks(
                    profile,
                    sgtool_baseline,
                    run_started_at,
                )
                removed, cleanup_error = launcher.remove_profile(profile)
            report["profileCleanupProcesses"] = cleanup_processes
            report["profileRemoved"] = removed
            report["profileCleanupError"] = cleanup_error
            if not removed:
                report["status"] = "failed"
                exit_code = 1
        (output_dir / "electron-personalization-runtime-acceptance.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    return report, exit_code


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-profile", type=pathlib.Path, required=True)
    parser.add_argument("--output-dir", type=pathlib.Path, required=True)
    parser.add_argument("--keep-profile", action="store_true")
    args = parser.parse_args()
    report, exit_code = run(args.source_profile, args.output_dir, args.keep_profile)
    print(json.dumps({
        "status": report.get("status"),
        "report": str((args.output_dir / "electron-personalization-runtime-acceptance.json").resolve()),
        "error": report.get("error"),
        "profileRemoved": report.get("profileRemoved"),
    }, ensure_ascii=False, indent=2))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
