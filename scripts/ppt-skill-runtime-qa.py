#!/usr/bin/env python3
"""
Gorden PPT Skill 集成运行时验收（2026-09-11 刘总要求集成）。

对真实构建的 Electron 应用做只读/无副作用验证：
1. `window.metis.listSkills()` 返回的技能注册表包含 gorden-ppt-skill（默认挂载成功）；
2. `window.metis.setActiveSkill('gorden-ppt-skill')` 真实生效（registry→IPC 链路）；
3. `setActiveSkill(null)` 可取消；
4. 截图留证。
模型真实生成 .pptx 的完整闭环需要已配置 Provider，属用户环境；自举与构建管线
已在本机用真实 git clone + python-pptx 构建验证（见集成报告）。
"""

from __future__ import annotations

import argparse
import base64
import json
import pathlib
import subprocess
import sys
import time
import urllib.request

import websocket

PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[1]
ELECTRON_EXE = PROJECT_ROOT / "node_modules" / "electron" / "dist" / "electron.exe"


def wait_for_cdp(port: int, timeout: float = 60.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception:
            time.sleep(0.5)
    raise TimeoutError(f"CDP port {port} did not come up")


def find_page_target(port: int, timeout: float = 90.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=2) as response:
                targets = json.loads(response.read().decode("utf-8"))
            pages = [t for t in targets if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
            if pages:
                return pages[0]
        except Exception:
            pass
        time.sleep(0.5)
    raise TimeoutError("no METIS renderer page target on CDP")


class CDP:
    def __init__(self, target: dict, port: int):
        self._id = 0
        self.socket = websocket.create_connection(
            target["webSocketDebuggerUrl"], origin=f"http://127.0.0.1:{port}", timeout=20,
        )

    def send(self, method: str, params: dict | None = None) -> dict:
        self._id += 1
        request_id = self._id
        self.socket.send(json.dumps({"id": request_id, "method": method, "params": params or {}}))
        deadline = time.time() + 20
        while time.time() < deadline:
            message = json.loads(self.socket.recv())
            if message.get("id") == request_id:
                if "error" in message:
                    raise RuntimeError(f"{method} failed: {message['error']}")
                return message.get("result", {})
        raise TimeoutError(f"CDP {method} timed out")

    def evaluate(self, expression: str):
        result = self.send("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True})
        return result.get("result", {}).get("value")

    def screenshot(self, path: pathlib.Path) -> None:
        data = self.send("Page.captureScreenshot", {"format": "png"})
        path.write_bytes(base64.b64decode(data["data"]))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=9226)
    parser.add_argument("--output-dir", default="logs/ppt-skill-qa")
    args = parser.parse_args()

    out_dir = PROJECT_ROOT / args.output_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    profile_dir = out_dir / "profile"
    profile_dir.mkdir(parents=True, exist_ok=True)

    process = subprocess.Popen(
        [
            str(ELECTRON_EXE), str(PROJECT_ROOT),
            f"--remote-debugging-port={args.port}",
            f"--remote-allow-origins=http://127.0.0.1:{args.port}",
            f"--user-data-dir={profile_dir}",
            "--disable-gpu",
        ],
        cwd=str(PROJECT_ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    report: dict = {"checks": [], "passed": False}
    try:
        wait_for_cdp(args.port)
        target = find_page_target(args.port)
        cdp = CDP(target, args.port)
        cdp.send("Page.enable")
        deadline = time.time() + 150
        hydrated = False
        while time.time() < deadline:
            if cdp.evaluate("document.querySelector('.topbar-nav') !== null") is True:
                hydrated = True
                break
            time.sleep(1)
        report["checks"].append({"check": "app hydrated", "ok": hydrated})
        if not hydrated:
            raise TimeoutError("app never hydrated")

        # 1) 技能注册表包含 gorden-ppt-skill
        skills = cdp.evaluate("window.metis?.listSkills ? window.metis.listSkills() : null")
        ppt = next((s for s in (skills or []) if s.get("id") == "gorden-ppt-skill"), None)
        report["checks"].append({
            "check": "skill registry contains gorden-ppt-skill",
            "ok": ppt is not None,
            "entry": ppt,
            "totalSkills": len(skills or []),
        })

        # 2) setActiveSkill 真实生效
        activated = cdp.evaluate("window.metis?.setActiveSkill ? window.metis.setActiveSkill('gorden-ppt-skill') : null")
        report["checks"].append({
            "check": "setActiveSkill('gorden-ppt-skill') succeeds",
            "ok": bool(activated and activated.get("success") and activated.get("active") == "gorden-ppt-skill"),
            "result": activated,
        })

        # 3) 可取消
        cleared = cdp.evaluate("window.metis?.setActiveSkill ? window.metis.setActiveSkill(null) : null")
        report["checks"].append({
            "check": "setActiveSkill(null) clears",
            "ok": bool(cleared and cleared.get("success") and cleared.get("active") is None),
            "result": cleared,
        })

        cdp.screenshot(out_dir / "chat-workspace-with-ppt-skill.png")
        report["screenshot"] = str((out_dir / "chat-workspace-with-ppt-skill.png").relative_to(PROJECT_ROOT))
        report["passed"] = all(c.get("ok") for c in report["checks"])
        cdp.socket.close()
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()

    report_path = out_dir / "ppt-skill-runtime-qa.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"[ppt-skill-qa] report: {report_path}")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
