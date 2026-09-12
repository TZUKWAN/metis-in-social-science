#!/usr/bin/env python3
"""
METIS Office × GordenPPTSkill 集成运行时验收（真实 Electron + 真实 python 构建）。

1. 预置技能包到一次性 profile 数据目录；
2. `window.metis.gordenPptListTemplates()` → 断言模板清单（含极简商务汇报）；
3. `window.metis.gordenPptBuildFromBrief()` → 真实跑技能 build_pptx.py 并转换
   为 METIS PPT Grid 文档；断言 ok、页数、标题内容、无模板占位残留；
4. 截图 + 报告 JSON。
"""
from __future__ import annotations

import base64
import json
import pathlib
import shutil
import subprocess
import sys
import time
import urllib.request

import websocket

PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[1]
ELECTRON_EXE = PROJECT_ROOT / "node_modules" / "electron" / "dist" / "electron.exe"
SKILL_SOURCE = pathlib.Path("D:/LATEXTEST/ppt-skill-qa/gorden-ppt-skill")
PORT = 9229


def wait_for_cdp(port: int, timeout: float = 60.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception:
            time.sleep(0.5)
    raise TimeoutError("CDP not up")


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
    raise TimeoutError("no page target")


class CDP:
    def __init__(self, target: dict, port: int):
        self._id = 0
        self.socket = websocket.create_connection(target["webSocketDebuggerUrl"], origin=f"http://127.0.0.1:{port}", timeout=90)

    def send(self, method: str, params: dict | None = None, timeout: float = 90) -> dict:
        self._id += 1
        request_id = self._id
        self.socket.settimeout(timeout)
        self.socket.send(json.dumps({"id": request_id, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            message = json.loads(self.socket.recv())
            if message.get("id") == request_id:
                if "error" in message:
                    raise RuntimeError(f"{method}: {message['error']}")
                return message.get("result", {})
        raise TimeoutError(method)

    def evaluate(self, expression: str, timeout: float = 90):
        return self.send("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True}, timeout=timeout).get("result", {}).get("value")

    def screenshot(self, path: pathlib.Path) -> None:
        data = self.send("Page.captureScreenshot", {"format": "png"})
        path.write_bytes(base64.b64decode(data["data"]))


def main() -> int:
    out_dir = PROJECT_ROOT / "logs" / "gorden-office-qa"
    out_dir.mkdir(parents=True, exist_ok=True)
    profile = out_dir / "profile"
    data_dir = profile / "metis-data"
    skill_dest = data_dir / "ppt-skill" / "gorden-ppt-skill"
    if SKILL_SOURCE.exists() and not (skill_dest / "SKILL.md").exists():
        skill_dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(SKILL_SOURCE, skill_dest, ignore=shutil.ignore_patterns(".git"))
    report: dict = {"steps": [], "passed": False}

    process = subprocess.Popen(
        [str(ELECTRON_EXE), str(PROJECT_ROOT),
         f"--remote-debugging-port={PORT}",
         f"--remote-allow-origins=http://127.0.0.1:{PORT}",
         f"--user-data-dir={profile}",
         "--disable-gpu"],
        cwd=str(PROJECT_ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        wait_for_cdp(PORT)
        target = find_page_target(PORT)
        cdp = CDP(target, PORT)
        cdp.send("Page.enable")
        deadline = time.time() + 150
        while time.time() < deadline:
            if cdp.evaluate("document.querySelector('.topbar-nav') !== null") is True:
                break
            time.sleep(1)
        report["steps"].append({"step": "hydrated", "ok": True})

        listed = cdp.evaluate("window.metis.gordenPptListTemplates()", timeout=120)
        templates = (listed or {}).get("templates") or []
        minimal = next((t for t in templates if t.get("slug") == "minimal-business-summary"), None)
        report["steps"].append({
            "step": "gordenPptListTemplates",
            "ok": bool((listed or {}).get("ok")) and minimal is not None,
            "templateCount": len(templates),
            "minimal": minimal,
        })

        build = cdp.evaluate(
            "window.metis.gordenPptBuildFromBrief(" + json.dumps({
                "slug": "minimal-business-summary",
                "title": "METIS Office 集成验收",
                "points": ["可执行场景：工作流即代码", "真实文献检索：DOI 逐条核验", "成果与投稿：Office 编辑 + 参谋选刊"],
                "maxSlides": 3,
            }) + ")", timeout=180)
        document = (build or {}).get("document") or {}
        all_text = json.dumps(document, ensure_ascii=False)
        checks = {
            "buildOk": bool((build or {}).get("ok")),
            "isPpt": document.get("type") == "ppt",
            "pageCount": len(document.get("pages", [])),
            "hasTitle": "METIS Office 集成验收" in all_text,
            "hasPoint": "真实文献检索" in all_text,
            "noPlaceholder": "Rice Husk" not in all_text and "Work completion" not in all_text and "Vivamus" not in all_text,
        }
        report["steps"].append({
            "step": "gordenPptBuildFromBrief",
            "ok": all([checks["buildOk"], checks["isPpt"], checks["pageCount"] == 3, checks["hasTitle"], checks["hasPoint"], checks["noPlaceholder"]]),
            "checks": checks,
            "fileName": (build or {}).get("fileName"),
            "buildLogTail": ((build or {}).get("buildLog") or "")[-200:],
        })

        cdp.screenshot(out_dir / "gorden-office-qa.png")
        report["passed"] = all(s.get("ok") for s in report["steps"])
        cdp.socket.close()
    except Exception as error:
        report["fatal"] = f"{type(error).__name__}: {error}"
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()

    (out_dir / "gorden-office-qa.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2)[:4000])
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
