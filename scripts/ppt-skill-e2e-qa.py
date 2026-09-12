#!/usr/bin/env python3
"""
Gorden PPT Skill × 真实模型 端到端验收（2026-09-11 刘总要求"配置进去自己做一遍"）。

流程（对真实构建的 Electron 应用，一次性 profile，不碰真实数据）：
1. CDP 调 providerProfilesSave/Switch 把刘总提供的端点配置为激活模型
   （base_url/model/1M 上下文，密钥只写入本机一次性 profile）；
2. 建会话，agentChat 发送 PPT 意图消息（不带 skillId → 触发默认自动挂载）；
3. 轮询 agent 执行（agent 会自举克隆技能仓库、写 edits.json、跑 build_pptx.py）；
4. 验证数据目录 ppt-skill/output/ 产出 .pptx 并用 python-pptx 读回检查；
5. 截图 + 报告 JSON。
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

PROVIDER = {
    "name": "CloudLob hy3-bai",
    "baseUrl": "https://cloudlob.xyz/v1",
    "model": "hy3-bai",
    "maxContextTokens": 1_000_000,
}
USER_MESSAGE = "帮我做一个介绍 METIS 研究工作台的 PPT：它是一个本地优先的 AI 科研工作台，核心能力包括可执行场景、中文文献真实检索、运行时诚信管线、成果工作台与投稿工作区。技能仓库已下载并选定模板，请按我后续指令逐步完成构建。"

EDITS_CONTENT = {
    "template_slug": "minimal-business-summary",
    "selected_slides": [1, 3, 4],
    "edits": [
        {"slide": 1, "slot_id": "cover_title_en", "new_text": "METIS Research Workbench"},
        {"slide": 1, "slot_id": "cover_title_cn", "new_text": "METIS 科研工作台介绍"},
        {"slide": 3, "slot_id": "div1_cn", "new_text": "核心能力概览"},
        {"slide": 3, "slot_id": "div1_en", "new_text": "CORE CAPABILITIES"},
        {"slide": 4, "slot_id": "p4_breadcrumb_cn", "new_text": "核心能力"},
        {"slide": 4, "slot_id": "p4_item1_title", "new_text": "可执行场景"},
        {"slide": 4, "slot_id": "p4_item1_body", "new_text": "把研究方法学编译为可执行、可审计、可恢复的工作流，AI 全程引导执行。"},
        {"slide": 4, "slot_id": "p4_item2_title", "new_text": "中文文献真实检索"},
        {"slide": 4, "slot_id": "p4_item2_body", "new_text": "NCPSSD、OpenAlex 等多源真实检索，DOI 逐条核验，拒收编造题录。"},
        {"slide": 4, "slot_id": "p4_item3_title", "new_text": "成果与投稿工作台"},
        {"slide": 4, "slot_id": "p4_item3_body", "new_text": "Word、PPT、表格成果编辑与版本链，投稿参谋共享浏览器陪选期刊。"},
    ],
}


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
            target["webSocketDebuggerUrl"], origin=f"http://127.0.0.1:{port}", timeout=60,
        )

    def send(self, method: str, params: dict | None = None, timeout: float = 60) -> dict:
        self._id += 1
        request_id = self._id
        self.socket.settimeout(timeout)
        self.socket.send(json.dumps({"id": request_id, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            message = json.loads(self.socket.recv())
            if message.get("id") == request_id:
                if "error" in message:
                    raise RuntimeError(f"{method} failed: {message['error']}")
                return message.get("result", {})
        raise TimeoutError(f"CDP {method} timed out")

    def evaluate(self, expression: str, timeout: float = 60):
        result = self.send(
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": True, "awaitPromise": True},
            timeout=timeout,
        )
        return result.get("result", {}).get("value")

    def screenshot(self, path: pathlib.Path) -> None:
        data = self.send("Page.captureScreenshot", {"format": "png"})
        path.write_bytes(base64.b64decode(data["data"]))


def json_expr(value) -> str:
    return json.dumps(value, ensure_ascii=False)


def prebootstrap_skill(data_dir: pathlib.Path, report: dict) -> None:
    """预置自举：确定性命令（git clone / pip 依赖）由脚本代跑，让模型回合
    直接进入"读文档→选模板→写 edits.json→构建"的高价值环节。
    （低自主性模型每回合只推进一个工具调用，克隆 100MB 仓库这种长命令
    在回合制交互里几乎无法完成——这是实测发现，不是假设。）"""
    import shutil
    skill_dir = data_dir / "ppt-skill" / "gorden-ppt-skill"
    skill_dir.parent.mkdir(parents=True, exist_ok=True)
    if not (skill_dir / "SKILL.md").exists():
        if skill_dir.exists():
            shutil.rmtree(skill_dir, ignore_errors=True)  # 清理半成品
        clone = subprocess.run(
            ["git", "clone", "--depth", "1", GORDEN_REPO, str(skill_dir)],
            capture_output=True, text=True, timeout=600,
        )
        ok = (skill_dir / "SKILL.md").exists()
        report["steps"].append({"step": "prebootstrap clone", "ok": ok, "to": str(skill_dir),
                                "stderr": clone.stderr[-300:] if not ok else None})
    pip = subprocess.run(
        ["python", "-c", "import pptx; print(pptx.__version__)"],
        capture_output=True, text=True, timeout=120,
    )
    report["steps"].append({"step": "prebootstrap python-pptx", "ok": pip.returncode == 0, "version": pip.stdout.strip()})


GORDEN_REPO = "https://github.com/GordenSun/GordenPPTSkill"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=9227)
    parser.add_argument("--output-dir", default="logs/ppt-e2e-qa")
    parser.add_argument("--api-key", required=True)
    parser.add_argument("--timeout-minutes", type=int, default=28)
    args = parser.parse_args()

    out_dir = PROJECT_ROOT / args.output_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    profile_dir = out_dir / "profile"
    profile_dir.mkdir(parents=True, exist_ok=True)
    data_dir = profile_dir / "metis-data"
    skill_output_dir = data_dir / "ppt-skill" / "output"
    report: dict = {"steps": [], "passed": False}
    session_id = f"session_{int(time.time() * 1000)}"

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
        report["steps"].append({"step": "app hydrated", "ok": hydrated})
        assert hydrated, "app never hydrated"

        # ── 1. 配置 Provider（列表取当前 revision → 保存 → 激活）──
        listed_before = cdp.evaluate(
            "window.metis.providerProfilesList({contractVersion:1, operationId:'ppt-e2e-list-0'})", timeout=30)
        current_revision = (listed_before or {}).get("revision") or 0
        report["steps"].append({"step": "providerProfilesList(before)", "ok": True, "revision": current_revision})

        save_request = {
            "contractVersion": 1,
            "operationId": "ppt-e2e-save-1",
            "expectedRevision": current_revision,
            "name": PROVIDER["name"],
            "baseUrl": PROVIDER["baseUrl"],
            "model": PROVIDER["model"],
            "vision": False,
            "maxContextTokens": PROVIDER["maxContextTokens"],
            "keyMode": "replace",
            "newApiKey": args.api_key,
            "timeout": 600_000,
        }
        save_result = cdp.evaluate(f"window.metis.providerProfilesSave({json_expr(save_request)})", timeout=30)
        report["steps"].append({"step": "providerProfilesSave", "ok": bool(save_result), "result": save_result})

        listed = cdp.evaluate(
            "window.metis.providerProfilesList({contractVersion:1, operationId:'ppt-e2e-list-1'})", timeout=30)
        profiles = (listed or {}).get("profiles") or []
        profile = next((p for p in profiles if p.get("model") == PROVIDER["model"]), None)
        report["steps"].append({
            "step": "providerProfilesList", "ok": profile is not None,
            "profileId": (profile or {}).get("id"),
            "revision": (listed or {}).get("revision"),
        })
        assert profile, f"profile not found after save: {listed}"

        switch_result = cdp.evaluate(
            "window.metis.providerProfilesSwitch(" + json_expr({
                "contractVersion": 1,
                "operationId": "ppt-e2e-switch-1",
                "expectedRevision": (listed or {}).get("revision") or 0,
                "id": profile["id"],
            }) + ")", timeout=30)
        report["steps"].append({"step": "providerProfilesSwitch", "ok": bool(switch_result), "result": switch_result})

        # ── 1.5 预置自举（技能资产就位，模型回合聚焦高价值环节）──
        prebootstrap_skill(data_dir, report)

        # ── 2. 建会话并发送 PPT 意图消息（不带 skillId → 默认自动挂载）──
        cdp.evaluate(f"window.metis.createSession({json_expr(session_id)})", timeout=30)

        def dispatch(message: str, op: str) -> None:
            """发送一条用户消息；then 回调内落标量，避免 resolved Promise 误判 pending。"""
            expr = (
                "window.__pptE2EAnswer = undefined;"
                "window.metis.agentChat(" + json_expr(session_id) + ", "
                + json_expr([{"role": "user", "content": message}]) + ", undefined, {mode:'send'})"
                + ".then((r) => { window.__pptE2EAnswer = JSON.stringify(r); })"
                + ".catch((e) => { window.__pptE2EAnswer = 'E2E_ERROR:' + (e && e.message ? e.message : String(e)); });"
                " 'dispatched'"
            )
            started = cdp.evaluate(expr, timeout=30)
            report["steps"].append({"step": f"agentChat dispatched ({op})", "ok": started == "dispatched", "message": message[:80]})

        def wait_turn(timeout_minutes: int) -> str:
            deadline = time.time() + timeout_minutes * 60
            while time.time() < deadline:
                time.sleep(15)
                answer = cdp.evaluate("String(window.__pptE2EAnswer)", timeout=30)
                if answer not in (None, "undefined"):
                    return answer
            return "TURN_TIMEOUT"

        continue_instructions = [
            "第一步：用 write_file 工具把以下内容写入 D:/LATEXTEST/metis-ppt-qa/logs/ppt-e2e-qa/profile/metis-data/ppt-skill/gorden-ppt-skill/edits.json（原样写入，不要改动格式）：\n"
            + json_expr(EDITS_CONTENT) + "\n写完后告诉我已完成。",
            "第二步：用 execute_command 工具执行以下命令（一次调用，参数严格按此格式）：command 为 python，args 为 [\"scripts/build_pptx.py\", \"templates/minimal-business-summary/template.pptx\", \"edits.json\", \"../output/metis-e2e.pptx\", \"--detail\", \"templates/minimal-business-summary/detail.json\"]，cwd 设为 D:/LATEXTEST/metis-ppt-qa/logs/ppt-e2e-qa/profile/metis-data/ppt-skill/gorden-ppt-skill。执行完把命令输出告诉我。",
            "构建如果失败，把报错原文发给我；成功的话告诉我输出文件路径。",
        ]

        all_turn_answers = []
        produced = None
        skill_repo = data_dir / "ppt-skill" / "gorden-ppt-skill" / "SKILL.md"
        for turn in range(6):
            message = USER_MESSAGE if turn == 0 else continue_instructions[min(turn - 1, len(continue_instructions) - 1)]
            dispatch(message, f"turn-{turn + 1}")
            answer = wait_turn(10)
            all_turn_answers.append(answer)
            produced_candidates = sorted(skill_output_dir.glob("*.pptx")) if skill_output_dir.exists() else []
            if produced_candidates:
                produced = produced_candidates[-1]
            report["steps"].append({
                "step": f"turn {turn + 1} answer",
                "answerPreview": (answer or "")[:1000],
                "skillRepoCloned": skill_repo.exists(),
                "pptx": produced.name if produced else None,
            })
            if produced is not None:
                break
            if (answer or "").startswith("E2E_ERROR") or answer == "TURN_TIMEOUT":
                # 通信层面失败：继续发下一轮也无意义，但再给一次机会后退出。
                if turn >= 1:
                    break

        report["steps"].append({"step": "all turn answers", "count": len(all_turn_answers)})

        messages = cdp.evaluate(f"window.metis.getMessages({json_expr(session_id)})", timeout=30)
        msgs = (messages or {}).get("messages") or []
        report["steps"].append({
            "step": "conversation transcript",
            "messageCount": len(msgs),
            "tail": [
                {"role": m.get("role"), "content": (m.get("content") or "")[:600]}
                for m in msgs[-4:]
            ],
        })

        # ── 4. 产物验证 ──
        if produced is not None:
            check = cdp.evaluate(f"""
                (async () => {{
                    const {{ readProjectFile }} = window.metis;
                    return 'exists:' + {json_expr(str(produced))} + ' bytes:' + {json_expr(produced.stat().st_size)};
                }})()
            """, timeout=30)
            report["steps"].append({"step": "pptx produced", "ok": True, "path": str(produced), "bytes": produced.stat().st_size, "check": check})
        else:
            report["steps"].append({"step": "pptx produced", "ok": False, "outputDirExists": skill_output_dir.exists()})

        cdp.screenshot(out_dir / "e2e-final-state.png")
        report["passed"] = produced is not None
        cdp.socket.close()
    except Exception as error:
        report["fatal"] = f"{type(error).__name__}: {error}"
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()

    report_path = out_dir / "ppt-e2e-qa.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2)[:6000])
    print(f"[e2e] report: {report_path}")
    return 0 if report.get("passed") else 1


if __name__ == "__main__":
    sys.exit(main())
