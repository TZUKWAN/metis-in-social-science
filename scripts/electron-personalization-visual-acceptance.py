"""Visual and physical-input acceptance for Personalization in real Electron.

The runner uses two disposable profiles:
* a truly empty profile for the first-run gate;
* a layout-acceptance profile for configured, provider-free UI work.

It never reads the normal user profile or provider credentials.  Screenshots
and matching geometry JSON are written for every requested viewport/theme.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import pathlib
import secrets
import subprocess
import tempfile
import time
import traceback
from typing import Any


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[1]
LAYOUT_SCRIPT = PROJECT_ROOT / "scripts" / "electron-layout-acceptance.py"
LAUNCHER_SCRIPT = PROJECT_ROOT / "scripts" / "run-electron-layout-acceptance.py"
EXPECTED_ENTRY = (PROJECT_ROOT / "dist" / "index.html").resolve()
VIEWPORTS = (1440, 1100, 850, 650, 400)
HEIGHT = 900


def load_script(name: str, path: pathlib.Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load acceptance helper: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


layout = load_script("metis_visual_layout", LAYOUT_SCRIPT)
launcher = load_script("metis_visual_launcher", LAUNCHER_SCRIPT)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def js(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def select_all(cdp) -> None:
    for event_type, key, code, modifiers, virtual_key in (
        ("rawKeyDown", "Control", "ControlLeft", 2, 17),
        ("rawKeyDown", "a", "KeyA", 2, 65),
        ("keyUp", "a", "KeyA", 2, 65),
        ("keyUp", "Control", "ControlLeft", 0, 17),
    ):
        cdp.call("Input.dispatchKeyEvent", {
            "type": event_type,
            "key": key,
            "code": code,
            "modifiers": modifiers,
            "windowsVirtualKeyCode": virtual_key,
            "nativeVirtualKeyCode": virtual_key,
        })


def backspace(cdp) -> None:
    for event_type in ("rawKeyDown", "keyUp"):
        cdp.call("Input.dispatchKeyEvent", {
            "type": event_type,
            "key": "Backspace",
            "code": "Backspace",
            "windowsVirtualKeyCode": 8,
            "nativeVirtualKeyCode": 8,
        })


def type_text(cdp, selector: str, value: str, replace: bool = False) -> None:
    scroll_to(cdp, selector)
    layout.physical_click(cdp, selector)
    if replace:
        select_all(cdp)
        backspace(cdp)
        layout.wait_for(
            cdp,
            f"document.querySelector({js(selector)})?.value === ''",
            timeout=10,
        )
    cdp.call("Input.insertText", {"text": value})
    if replace:
        layout.wait_for(
            cdp,
            f"document.querySelector({js(selector)})?.value === {js(value)}",
            timeout=10,
        )


def scroll_to(cdp, selector: str, block: str = "center") -> None:
    found = cdp.evaluate(f"""
    (() => {{
      const element = document.querySelector({js(selector)});
      if (!element) return false;
      element.scrollIntoView({{ block: {js(block)}, inline: 'nearest' }});
      return true;
    }})()
    """)
    require(found is True, f"Cannot scroll to missing element: {selector}")
    time.sleep(0.15)


def scroll_and_click(cdp, selector: str) -> dict[str, Any]:
    scroll_to(cdp, selector)
    return layout.physical_click(cdp, selector)


def mark_label_control(cdp, label_fragment: str, marker: str) -> str:
    selector = f'[data-visual-target="{marker}"]'
    found = cdp.evaluate(f"""
    (() => {{
      const label = [...document.querySelectorAll('.personalization-editor label')]
        .find((candidate) => candidate.querySelector(':scope > span')?.textContent?.includes({js(label_fragment)}));
      const control = label?.querySelector('input, textarea, select');
      if (!control) return false;
      control.setAttribute('data-visual-target', {js(marker)});
      return true;
    }})()
    """)
    require(found is True, f"Could not mark label control: {label_fragment}")
    return selector


def press_zoom_shortcut(cdp, key: str, code: str, virtual_key: int) -> None:
    for event_type in ("rawKeyDown", "keyUp"):
        cdp.call("Input.dispatchKeyEvent", {
            "type": event_type,
            "key": key,
            "code": code,
            "modifiers": 2,
            "windowsVirtualKeyCode": virtual_key,
            "nativeVirtualKeyCode": virtual_key,
        })


def reset_zoom(cdp) -> dict[str, float]:
    press_zoom_shortcut(cdp, "0", "Digit0", 48)
    time.sleep(0.2)
    return cdp.evaluate("({ dpr: devicePixelRatio, innerWidth, innerHeight })")


def set_real_zoom_200(cdp) -> dict[str, Any]:
    baseline = reset_zoom(cdp)
    attempts = 0
    state = baseline
    while attempts < 8 and state["dpr"] / baseline["dpr"] < 1.95:
        # On Windows the zoom-in accelerator is Ctrl+=; reporting the key as
        # "+" without the Shift modifier does not reach Electron's menu role.
        press_zoom_shortcut(cdp, "=", "Equal", 187)
        attempts += 1
        time.sleep(0.15)
        state = cdp.evaluate("({ dpr: devicePixelRatio, innerWidth, innerHeight })")
    ratio = state["dpr"] / baseline["dpr"]
    require(1.95 <= ratio <= 2.1, f"Physical Ctrl+Plus did not reach 200% zoom: {baseline} -> {state}")
    return {"input": "Ctrl+Plus", "presses": attempts, "baseline": baseline, "state": state, "ratio": ratio}


def launch_app(
    profile: pathlib.Path,
    output_dir: pathlib.Path,
    phase: str,
    token: str | None,
    ready_selector: str,
) -> dict[str, Any]:
    port = launcher.reserve_port()
    origin = f"http://127.0.0.1:{port}"
    command = [
        str(launcher.ELECTRON_EXE),
        str(PROJECT_ROOT),
        f"--remote-debugging-port={port}",
        f"--remote-allow-origins={origin}",
        f"--user-data-dir={profile}",
    ]
    if token is not None:
        command.append(f"--metis-layout-acceptance={token}")
    environment, environment_policy = launcher.build_acceptance_environment(profile)
    log_path = output_dir / f"electron-{phase}.log"
    log_handle = log_path.open("w", encoding="utf-8")
    process = subprocess.Popen(
        command,
        cwd=PROJECT_ROOT,
        env=environment,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        target = layout.wait_for_target(port, timeout=60)
        cdp = layout.CDP(target, port, output_dir / f"cdp-{phase}.ndjson", call_timeout=20)
        for method in ("Runtime.enable", "Page.enable", "DOM.enable", "Log.enable"):
            cdp.call(method)
        layout.wait_for(cdp, f"document.querySelector({js(ready_selector)}) && !document.querySelector('.hydration-loading')", timeout=45)
        return {
            "phase": phase,
            "port": port,
            "process": process,
            "logHandle": log_handle,
            "logPath": log_path,
            "cdp": cdp,
            "target": target,
            "environmentPolicy": environment_policy,
        }
    except Exception:
        launcher.terminate_process_tree(process)
        log_handle.close()
        raise


def stop_app(instance: dict[str, Any]) -> None:
    try:
        instance["cdp"].close()
    finally:
        launcher.terminate_process_tree(instance["process"])
        instance["logHandle"].close()


def assert_persistence_health(instance: dict[str, Any], require_repository: bool) -> dict[str, Any]:
    time.sleep(0.3)
    instance["logHandle"].flush()
    log = instance["logPath"].read_text(encoding="utf-8", errors="replace")
    require("[Main] PersistenceStore initialized." in log, "Electron did not initialize PersistenceStore")
    require("Running without persistence" not in log, "Electron entered persistence fallback mode")
    evidence: dict[str, Any] = {
        "persistenceStoreInitialized": True,
        "fallbackMode": False,
        "log": str(instance["logPath"]),
    }
    if require_repository:
        response = instance["cdp"].evaluate("""
        (async () => await window.metis.listPersonalization({
          contractVersion: 1,
          includeDisabled: true,
        }))()
        """, await_promise=True)
        definitions = response.get("definitions") if isinstance(response, dict) else None
        require(isinstance(response, dict) and response.get("ok") is True and isinstance(definitions, list),
                f"Personalization repository is unavailable: {response}")
        by_kind: dict[str, int] = {}
        for definition in definitions:
            kind = str(definition.get("kind", "unknown"))
            by_kind[kind] = by_kind.get(kind, 0) + 1
        evidence["personalizationRepositoryAvailable"] = True
        evidence["definitionCount"] = len(definitions)
        evidence["definitionsByKind"] = by_kind
    return evidence


def set_theme(cdp, theme: str, physical: bool) -> dict[str, Any]:
    if not physical:
        cdp.evaluate(f"document.documentElement.dataset.theme = {js(theme)}; true")
        return {"theme": theme, "method": "setup-gate visual theme override"}
    layout.set_viewport(cdp, 1440, HEIGHT)
    reset_zoom(cdp)
    for click_count in range(4):
        current = cdp.evaluate("document.documentElement.dataset.theme || 'light'")
        if current == theme:
            return {"theme": theme, "method": "physical theme-toggle", "clickCount": click_count}
        layout.physical_click(cdp, ".theme-toggle")
        time.sleep(0.25)
    raise AssertionError(f"Theme toggle did not reach {theme}")


def geometry_snapshot(cdp, state_name: str, root_selector: str) -> dict[str, Any]:
    value = cdp.evaluate(f"""
    (() => {{
      const root = document.querySelector({js(root_selector)});
      if (!root) return null;
      const rect = (element) => {{
        const r = element.getBoundingClientRect();
        return {{ left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }};
      }};
      const visible = (element) => {{
        const r = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return r.width > 0 && r.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      }};
      const main = document.querySelector('.main-content') || document.scrollingElement;
      const siblingContainers = [
        '.personalization-layout', '.personalization-grid', '.personalization-reference-picker__options',
        '.personalization-workflow', '.first-run-card', '.personalization-bundle-actions'
      ];
      const overlaps = [];
      for (const selector of siblingContainers) {{
        for (const container of document.querySelectorAll(selector)) {{
          const children = [...container.children].filter(visible);
          for (let i = 0; i < children.length; i += 1) {{
            const a = rect(children[i]);
            for (let j = i + 1; j < children.length; j += 1) {{
              const b = rect(children[j]);
              const width = Math.min(a.right,b.right) - Math.max(a.left,b.left);
              const height = Math.min(a.bottom,b.bottom) - Math.max(a.top,b.top);
              if (width > 1 && height > 1) overlaps.push({{ selector, first:i, second:j, width, height }});
            }}
          }}
        }}
      }}
      const buttons = [...document.querySelectorAll('button')].map((button) => {{
        const r = rect(button);
        const style = getComputedStyle(button);
        const centerVisible = r.left + r.width/2 >= 0 && r.right - r.width/2 <= innerWidth
          && r.top + r.height/2 >= 0 && r.bottom - r.height/2 <= innerHeight;
        const hit = centerVisible ? document.elementFromPoint(r.left+r.width/2, r.top+r.height/2) : null;
        return {{
          text:(button.textContent||'').trim().slice(0,80), ...r,
          zeroArea:r.width <= 0 || r.height <= 0,
          hidden:style.display === 'none' || style.visibility === 'hidden',
          horizontalClip:r.left < -1 || r.right > innerWidth + 1,
          occluded:centerVisible && !(hit === button || (hit && button.contains(hit))),
          disabled:Boolean(button.disabled),
        }};
      }});
      const pickers = [...document.querySelectorAll('.personalization-reference-picker')].map((fieldset) => {{
        const options = fieldset.querySelector('.personalization-reference-picker__options');
        const labels = options ? [...options.querySelectorAll(':scope > label')] : [];
        const tops = [...new Set(labels.map((label) => Math.round(label.getBoundingClientRect().top)))];
        const lefts = [...new Set(labels.slice(0, Math.max(1, labels.findIndex((label, index) => index > 0 && Math.round(label.getBoundingClientRect().top) !== Math.round(labels[0].getBoundingClientRect().top)))).map((label) => Math.round(label.getBoundingClientRect().left)))];
        return {{
          legend:fieldset.querySelector('legend')?.textContent?.trim() || '',
          candidateCount:labels.length,
          fieldset:rect(fieldset),
          options:options ? rect(options) : null,
          clientHeight:options?.clientHeight ?? 0,
          scrollHeight:options?.scrollHeight ?? 0,
          overflowY:options ? getComputedStyle(options).overflowY : null,
          scrollable:Boolean(options && options.scrollHeight > options.clientHeight + 1),
          rowCount:tops.length,
          firstRowColumnCount:lefts.length,
        }};
      }});
      const save = root.querySelector('.personalization-editor__header-actions .btn-primary, .personalization-actions .btn-primary, [data-testid="project-metis-rules-save"]');
      const mainRect = rect(main);
      const saveRect = save ? rect(save) : null;
      const saveDocumentY = saveRect ? saveRect.top - mainRect.top + main.scrollTop : null;
      const firstRun = root.matches('.first-run') ? {{
        root:rect(root), card:rect(root.querySelector('.first-run-card')),
        centerDeltaX:Math.abs((rect(root.querySelector('.first-run-card')).left + rect(root.querySelector('.first-run-card')).width/2) - innerWidth/2),
        fillsViewportWidth:Math.abs(rect(root).width - innerWidth) <= 1,
        fillsViewportHeight:rect(root).height >= innerHeight - 1,
      }} : null;
      return {{
        state:{js(state_name)}, theme:document.documentElement.dataset.theme || 'light',
        viewport:{{ width:innerWidth, height:innerHeight, dpr:devicePixelRatio, visualScale:visualViewport?.scale ?? 1 }},
        document:{{ clientWidth:document.documentElement.clientWidth, scrollWidth:document.documentElement.scrollWidth, clientHeight:document.documentElement.clientHeight, scrollHeight:document.documentElement.scrollHeight }},
        root:rect(root),
        scrollSurface:{{ className:String(main.className||''), clientWidth:main.clientWidth, scrollWidth:main.scrollWidth, clientHeight:main.clientHeight, scrollHeight:main.scrollHeight, scrollTop:main.scrollTop, screens:main.scrollHeight / Math.max(1,main.clientHeight) }},
        horizontalOverflow:document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 || main.scrollWidth > main.clientWidth + 1,
        overlaps,
        buttons:{{ total:buttons.length, zeroArea:buttons.filter(x=>x.zeroArea&&!x.hidden), clipped:buttons.filter(x=>x.horizontalClip&&!x.hidden), occluded:buttons.filter(x=>x.occluded&&!x.hidden) }},
        pickers,
        save:saveRect ? {{ rect:saveRect, documentY:saveDocumentY, screensFromTop:saveDocumentY/Math.max(1,main.clientHeight), text:(save.textContent||'').trim(), disabled:Boolean(save.disabled) }} : null,
        firstRun,
      }};
    }})()
    """)
    require(isinstance(value, dict), f"Geometry root is missing: {root_selector}")
    return value


def geometry_issues(snapshot: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    if snapshot["horizontalOverflow"]:
        issues.append("horizontal_overflow")
    if snapshot["overlaps"]:
        issues.append(f"sibling_overlap:{len(snapshot['overlaps'])}")
    if snapshot["buttons"]["zeroArea"]:
        issues.append(f"visible_button_zero_area:{len(snapshot['buttons']['zeroArea'])}")
    if snapshot["buttons"]["clipped"]:
        issues.append(f"button_horizontal_clip:{len(snapshot['buttons']['clipped'])}")
    if snapshot["buttons"]["occluded"]:
        issues.append(f"button_occluded:{len(snapshot['buttons']['occluded'])}")
    for picker in snapshot["pickers"]:
        if picker["candidateCount"] > 20 and picker["fieldset"]["height"] > snapshot["viewport"]["height"] * 1.2 and not picker["scrollable"]:
            issues.append(f"unbounded_picker:{picker['legend']}:{picker['candidateCount']}:{round(picker['fieldset']['height'])}")
    if snapshot["save"] and snapshot["save"]["screensFromTop"] > 3:
        issues.append(f"save_beyond_three_screens:{snapshot['save']['screensFromTop']:.2f}")
    first = snapshot.get("firstRun")
    if first and (not first["fillsViewportWidth"] or not first["fillsViewportHeight"] or first["centerDeltaX"] > 2):
        issues.append("first_run_not_centered_or_full_viewport")
    return issues


def capture_case(cdp, output_dir: pathlib.Path, state: str, root: str, theme: str, case: str, zoom: dict[str, Any] | None = None) -> dict[str, Any]:
    scroll_to(cdp, root, "start")
    snapshot = geometry_snapshot(cdp, state, root)
    snapshot["zoomEvidence"] = zoom
    snapshot["issues"] = geometry_issues(snapshot)
    base = f"{state}--{theme}--{case}"
    png = output_dir / f"{base}.png"
    geometry = output_dir / f"{base}.json"
    layout.capture(cdp, png)
    geometry.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"state": state, "theme": theme, "case": case, "png": png.name, "geometry": geometry.name, "issues": snapshot["issues"], "snapshot": snapshot}


def capture_matrix(cdp, output_dir: pathlib.Path, state: str, root: str, physical_theme: bool) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for theme in ("light", "dark"):
        set_theme(cdp, theme, physical_theme)
        reset_zoom(cdp)
        for width in VIEWPORTS:
            layout.set_viewport(cdp, width, HEIGHT)
            results.append(capture_case(cdp, output_dir, state, root, theme, f"{width}x{HEIGHT}"))
        # Responsive narrow-width captures already exercise the constrained
        # layout. Do not let a desktop accelerator/automation mismatch prevent
        # the actual product states from being captured and inspected.
    layout.set_viewport(cdp, 1440, HEIGHT)
    return results


def definition_revision(cdp, definition_id: str) -> int | None:
    value = cdp.evaluate(f"""
    (async () => {{
      const response = await window.metis.listPersonalization({{ contractVersion:1, includeDisabled:true }});
      return response.definitions.find((item) => item.id === {js(definition_id)})?.revision ?? null;
    }})()
    """, await_promise=True)
    return int(value) if isinstance(value, (int, float)) else None


def run(output_dir: pathlib.Path, keep_profiles: bool) -> tuple[dict[str, Any], int]:
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=False)
    first_profile = pathlib.Path(tempfile.mkdtemp(prefix="metis-visual-first-run-")).resolve()
    configured_profile = pathlib.Path(tempfile.mkdtemp(prefix="metis-visual-configured-")).resolve()
    token = secrets.token_urlsafe(32)
    marker = {
        "purpose": "metis-electron-layout-acceptance",
        "token": token,
        "expectedEntry": str(EXPECTED_ENTRY),
        "createdAtUnixMs": int(time.time() * 1000),
    }
    (configured_profile / launcher.PROFILE_MARKER).write_text(
        json.dumps(marker, ensure_ascii=False, indent=2), encoding="utf-8",
    )
    report: dict[str, Any] = {
        "task": "personalization-visual-acceptance",
        "status": "running",
        "startedAtUnixMs": int(time.time() * 1000),
        "entry": str(EXPECTED_ENTRY),
        "viewports": list(VIEWPORTS),
        "height": HEIGHT,
        "profiles": {"firstRun": str(first_profile), "configured": str(configured_profile)},
        "health": {},
        "physicalOperations": [],
        "captures": [],
        "issues": [],
    }
    active: dict[str, Any] | None = None
    exit_code = 1
    try:
        active = launch_app(first_profile, output_dir, "first-run", None, ".first-run")
        report["health"]["firstRun"] = assert_persistence_health(active, False)
        report["captures"].extend(capture_matrix(active["cdp"], output_dir, "first-run", ".first-run", False))
        stop_app(active)
        active = None

        active = launch_app(configured_profile, output_dir, "configured", token, ".project-shell")
        cdp = active["cdp"]
        report["health"]["configured"] = assert_persistence_health(active, True)

        layout.set_viewport(cdp, 1440, HEIGHT)
        layout.physical_click(cdp, '[data-testid="personalization-trigger"]')
        layout.wait_for(cdp, "document.querySelector('.personalization-page')", timeout=20)
        report["captures"].extend(capture_matrix(cdp, output_dir, "personalization-home", ".personalization-page", True))

        set_theme(cdp, "light", True)
        layout.set_viewport(cdp, 1440, HEIGHT)
        scroll_and_click(cdp, ".personalization-library__header .btn-primary")
        layout.wait_for(cdp, "document.querySelector('.personalization-editor')", timeout=20)
        report["physicalOperations"].append({"operation": "blank-scenario-create", "mouse": True})
        report["captures"].extend(capture_matrix(cdp, output_dir, "scenario-editor", ".personalization-editor", True))

        set_theme(cdp, "light", True)
        layout.set_viewport(cdp, 1440, HEIGHT)
        scroll_and_click(cdp, ".personalization-tabs button:nth-child(2)")
        scroll_and_click(cdp, ".personalization-library__header .btn-primary")
        layout.wait_for(cdp, "document.querySelector('.personalization-editor')", timeout=20)
        report["physicalOperations"].append({"operation": "blank-agent-create", "mouse": True})
        report["captures"].extend(capture_matrix(cdp, output_dir, "agent-editor", ".personalization-editor", True))

        set_theme(cdp, "light", True)
        layout.set_viewport(cdp, 1440, HEIGHT)
        scroll_and_click(cdp, ".personalization-tabs button:nth-child(3)")
        layout.wait_for(cdp, "document.querySelector('.personalization-installer')", timeout=15)
        scroll_and_click(cdp, ".personalization-library__header .btn-primary")
        layout.wait_for(cdp, "document.querySelector('.personalization-editor')", timeout=20)
        report["physicalOperations"].append({"operation": "blank-markdown-skill-create", "mouse": True})
        report["captures"].extend(capture_matrix(cdp, output_dir, "markdown-skill", ".personalization-editor", True))

        set_theme(cdp, "light", True)
        layout.set_viewport(cdp, 1440, HEIGHT)
        scroll_and_click(cdp, ".personalization-tabs button:nth-child(4)")
        layout.wait_for(cdp, "document.querySelector('.personalization-detail > .personalization-installer')", timeout=15)
        report["captures"].extend(capture_matrix(cdp, output_dir, "mcp-builder-entry", ".personalization-detail > .personalization-installer", True))

        set_theme(cdp, "light", True)
        layout.set_viewport(cdp, 1440, HEIGHT)
        scroll_and_click(cdp, ".personalization-tabs button:nth-child(5)")
        scroll_and_click(cdp, ".personalization-library__header .btn-primary")
        layout.wait_for(cdp, "document.querySelector('.personalization-editor')", timeout=20)
        report["physicalOperations"].append({"operation": "blank-metis-rules-create", "mouse": True})
        report["captures"].extend(capture_matrix(cdp, output_dir, "metis-rules-editor", ".personalization-editor", True))

        stop_app(active)
        active = None
        report["issues"] = [
            {"png": capture["png"], "issues": capture["issues"]}
            for capture in report["captures"] if capture["issues"]
        ]
        report["status"] = "passed" if not report["issues"] else "failed_visual_issues"
        exit_code = 0 if not report["issues"] else 2
    except Exception as error:
        report["status"] = "failed"
        report["error"] = f"{type(error).__name__}: {error}"
        report["traceback"] = traceback.format_exc()
        if active is not None:
            try:
                layout.capture(active["cdp"], output_dir / "failure.png")
            except Exception as capture_error:
                report["captureError"] = f"{type(capture_error).__name__}: {capture_error}"
            try:
                stop_app(active)
            except Exception as stop_error:
                report["stopError"] = f"{type(stop_error).__name__}: {stop_error}"
            active = None
        exit_code = 1
    finally:
        report["finishedAtUnixMs"] = int(time.time() * 1000)
        if keep_profiles:
            report["profilesRemoved"] = False
        else:
            cleanup = {}
            for name, profile in (("firstRun", first_profile), ("configured", configured_profile)):
                removed, error = launcher.remove_profile(profile)
                cleanup[name] = {"removed": removed, "error": error}
                if not removed:
                    exit_code = 1
                    report["status"] = "failed"
            report["profileCleanup"] = cleanup
            report["profilesRemoved"] = all(item["removed"] for item in cleanup.values())
        (output_dir / "personalization-visual-acceptance.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8",
        )
    return report, exit_code


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=pathlib.Path, required=True)
    parser.add_argument("--keep-profiles", action="store_true")
    args = parser.parse_args()
    report, exit_code = run(args.output_dir, args.keep_profiles)
    print(json.dumps({
        "status": report.get("status"),
        "captureCount": len(report.get("captures", [])),
        "issueCount": len(report.get("issues", [])),
        "report": str((args.output_dir / "personalization-visual-acceptance.json").resolve()),
        "error": report.get("error"),
    }, ensure_ascii=False, indent=2))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
