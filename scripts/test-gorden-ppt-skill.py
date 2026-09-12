#!/usr/bin/env python3
"""
Gorden PPT Skill 生成功能测试套件（任务：对技能的 PPT 生成功能做测试，确保可用）。

对一个技能包目录（默认 DATA_DIR/ppt-skill/gorden-ppt-skill，也可 --skill-dir 指定
任意克隆）做三层测试：

  [1] 模板资产结构校验：每个模板的 template.pptx 可被 python-pptx 打开、
      detail.json 可解析且含 slot 数据、intro.md/preview.png 存在。
  [2] 端到端构建测试：对 --samples 指定的代表性模板，用真实 edits.json 跑
      scripts/build_pptx.py，校验：退出码 0、输出 .pptx 可打开、页数正确、
      替换文本真实存在、无残留占位词（"Question"/"Vivamus"/"项目名称"等）。
  [3] 渲染测试：scripts/render_slides.py 产出逐页 PNG（需要 LibreOffice +
      poppler；缺失时如实标记 SKIP，不冒充通过）。

退出码：全部必需测试通过=0；任一 FAIL=1；SKIP 不影响退出码。
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import subprocess
import sys
import tempfile

REQUIRED_TEMPLATE_FILES = ["template.pptx", "detail.json", "intro.md", "preview.png"]
# 常见模板占位词（SKILL.md 编辑铁律 2：成品中不得残留）。
PLACEHOLDER_PATTERNS = [
    r"Vivamus", r"Lorem ipsum", r"Question \d", r"Key Words Here",
    r"项目名称", r"此处输入", r"点击输入",
]


def run(cmd: list[str], cwd: pathlib.Path | None = None, timeout: int = 300) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=str(cwd) if cwd else None, capture_output=True, text=True, timeout=timeout, encoding="utf-8", errors="ignore")


def check_template_assets(skill_dir: pathlib.Path, results: list[dict]) -> int:
    from pptx import Presentation
    failures = 0
    templates_dir = skill_dir / "templates"
    slugs = sorted(d.name for d in templates_dir.iterdir() if d.is_dir())
    results.append({"test": "template inventory", "detail": f"{len(slugs)} templates"})
    for slug in slugs:
        tdir = templates_dir / slug
        missing = [f for f in REQUIRED_TEMPLATE_FILES if not (tdir / f).exists()]
        if missing:
            results.append({"test": f"assets:{slug}", "ok": False, "detail": f"missing {missing}"})
            failures += 1
            continue
        try:
            prs = Presentation(str(tdir / "template.pptx"))
            slide_count = len(prs.slides)
        except Exception as error:
            results.append({"test": f"pptx-open:{slug}", "ok": False, "detail": str(error)[:200]})
            failures += 1
            continue
        try:
            detail = json.loads((tdir / "detail.json").read_text(encoding="utf-8"))
            detail_slides = len(detail.get("pages", []))
            slot_total = sum(len(p.get("text_slots", [])) for p in detail.get("pages", []))
        except Exception as error:
            results.append({"test": f"detail-json:{slug}", "ok": False, "detail": str(error)[:200]})
            failures += 1
            continue
        consistent = detail_slides == slide_count
        results.append({
            "test": f"assets:{slug}", "ok": consistent,
            "detail": f"pptx={slide_count}p detail={detail_slides}p slots={slot_total}",
            **({} if consistent else {"note": "slide count mismatch"}),
        })
        failures += 0 if consistent else 1
    return failures


def check_e2e_builds(skill_dir: pathlib.Path, samples: list[str], results: list[dict]) -> int:
    from pptx import Presentation
    failures = 0
    out_root = pathlib.Path(tempfile.mkdtemp(prefix="ppt-skill-e2e-"))
    for slug in samples:
        tdir = skill_dir / "templates" / slug
        detail = json.loads((tdir / "detail.json").read_text(encoding="utf-8"))
        # 从 detail.json 取真实 slot，构造两处替换（封面标题 + 任一正文标题）。
        edits: list[dict] = []
        selected: list[int] = []
        for page in detail.get("pages", []):
            slots = {s["slot_id"]: s for s in page.get("text_slots", [])}
            if not slots:
                continue
            slide = page["slide_number"]
            selected.append(slide)
            for slot_id in list(slots)[:2]:
                if slots[slot_id].get("editable", True) is False:
                    continue
                edits.append({"slide": slide, "slot_id": slot_id,
                              "new_text": f"METIS-{slug}-{slot_id} 测试"})
            if len(selected) >= 3:
                break
        if not edits:
            results.append({"test": f"e2e:{slug}", "ok": False, "detail": "no editable slots found"})
            failures += 1
            continue
        edits_file = out_root / f"{slug}-edits.json"
        edits_file.write_text(json.dumps({
            "template_slug": slug, "selected_slides": selected, "edits": edits,
        }, ensure_ascii=False), encoding="utf-8")
        out_file = out_root / f"{slug}-out.pptx"
        build = run([
            sys.executable, "scripts/build_pptx.py",
            f"templates/{slug}/template.pptx", str(edits_file), str(out_file),
            "--detail", f"templates/{slug}/detail.json",
        ], cwd=skill_dir, timeout=300)
        if build.returncode != 0 or not out_file.exists():
            results.append({"test": f"e2e:{slug}", "ok": False,
                            "detail": f"rc={build.returncode} stderr={build.stderr[-300:]} produced={out_file.exists()}"})
            failures += 1
            continue
        try:
            prs = Presentation(str(out_file))
            actual_slides = len(prs.slides)
            texts: list[str] = []
            for slide in prs.slides:
                for shape in slide.shapes:
                    if shape.has_text_frame:
                        texts.append(shape.text_frame.text)
            all_text = "\n".join(texts)
        except Exception as error:
            results.append({"test": f"e2e:{slug}", "ok": False, "detail": f"output unreadable: {error}"})
            failures += 1
            continue
        replaced_missing = [e["new_text"] for e in edits if e["new_text"] not in all_text]
        placeholders_left = [pat for pat in PLACEHOLDER_PATTERNS if re.search(pat, all_text, re.IGNORECASE)]
        page_ok = actual_slides == len(selected)
        ok = page_ok and not replaced_missing and not placeholders_left
        results.append({
            "test": f"e2e:{slug}", "ok": ok,
            "detail": f"slides={actual_slides}/{len(selected)} replaced={len(edits) - len(replaced_missing)}/{len(edits)}",
            **({} if not replaced_missing else {"missingReplacements": replaced_missing[:3]}),
            **({} if not placeholders_left else {"placeholdersLeft": placeholders_left}),
        })
        failures += 0 if ok else 1
    return failures


def check_render(skill_dir: pathlib.Path, sample_pptx: pathlib.Path, results: list[dict]) -> int:
    soffice = run(["soffice", "--version"], timeout=60) if sys.platform != "win32" else run(["where", "soffice"], timeout=60)
    available = (soffice.returncode == 0) and ("LibreOffice" in (soffice.stdout + soffice.stderr) or soffice.stdout.strip())
    if not available:
        results.append({"test": "render:slides", "ok": None, "detail": "SKIP: LibreOffice not available on this machine"})
        return 0
    out_dir = sample_pptx.parent / "render"
    render = run([sys.executable, "scripts/render_slides.py", str(sample_pptx), str(out_dir), "--dpi", "96"],
                 cwd=skill_dir, timeout=300)
    pngs = list(out_dir.glob("*.png")) if out_dir.exists() else []
    ok = render.returncode == 0 and len(pngs) > 0
    results.append({"test": "render:slides", "ok": ok, "detail": f"pngs={len(pngs)} rc={render.returncode}"})
    return 0 if ok else 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skill-dir", default="logs/ppt-e2e-qa/profile/metis-data/ppt-skill/gorden-ppt-skill",
                        help="技能包目录（默认 METIS 数据目录内自举克隆）")
    parser.add_argument("--samples", default="minimal-business-summary,thesis-novice,report-massive-charts",
                        help="端到端构建测试的模板 slug 列表")
    parser.add_argument("--output", default="logs/ppt-skill-test-report.json")
    args = parser.parse_args()

    skill_dir = pathlib.Path(args.skill_dir).resolve()
    results: list[dict] = []
    overall = {"skillDir": str(skill_dir), "results": results, "passed": False}

    if not (skill_dir / "SKILL.md").exists():
        overall["error"] = f"skill package not found at {skill_dir}"
        print(json.dumps(overall, ensure_ascii=False, indent=2))
        return 1

    failures = 0
    print("== [1] template assets ==", flush=True)
    failures += check_template_assets(skill_dir, results)
    print("== [2] end-to-end builds ==", flush=True)
    samples = [s.strip() for s in args.samples.split(",") if s.strip()]
    failures += check_e2e_builds(skill_dir, samples, results)
    print("== [3] render ==", flush=True)
    first_sample_out = pathlib.Path(tempfile.gettempdir()) / "ppt-skill-e2e-"  # 渲染用第一个成功产物
    sample = sorted(pathlib.Path(tempfile.gettempdir()).glob("ppt-skill-e2e-*/*-out.pptx"))
    failures += check_render(skill_dir, sample[-1] if sample else (skill_dir / "templates" / samples[0] / "template.pptx"), results)

    overall["passed"] = failures == 0
    overall["failures"] = failures
    out_path = pathlib.Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(overall, ensure_ascii=False, indent=2), encoding="utf-8")
    for r in results:
        status = "PASS" if r.get("ok") is True else ("SKIP" if r.get("ok") is None else "FAIL")
        print(f"[{status}] {r.get('test')}: {r.get('detail', '')[:150]}")
    print(f"\nreport: {out_path}\noverall: {'PASS' if overall['passed'] else 'FAIL'} ({failures} failures)")
    return 0 if overall["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
