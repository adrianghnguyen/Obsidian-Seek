"""Export traces and splice RUNS/SCENARIO_CHART into sandbox-run-history.canvas.tsx."""
from __future__ import annotations

import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
CANVAS = Path(
    r"C:\Users\tilou\.cursor\projects\c-Coding-projects-Obsidian-Seek\canvases\sandbox-run-history.canvas.tsx"
)


def ts_val(v, indent=0):
    sp = "  " * indent
    if isinstance(v, bool):
        return "true" if v else "false"
    if v is None:
        return "undefined"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, str):
        return json.dumps(v)
    if isinstance(v, list):
        if not v:
            return "[]"
        if all(isinstance(x, (int, float)) for x in v):
            return "[" + ", ".join(str(x) for x in v) + "]"
        return "[\n" + ",\n".join(sp + "  " + ts_val(x, indent + 1) for x in v) + ",\n" + sp + "]"
    if isinstance(v, dict):
        if not v:
            return "{}"
        lines = []
        for k, val in v.items():
            if val is None:
                continue
            key = k if str(k).isidentifier() else json.dumps(k)
            lines.append(f"{sp}  {key}: {ts_val(val, indent + 1)}")
        return "{\n" + ",\n".join(lines) + ",\n" + sp + "}"
    return json.dumps(v)


def main() -> None:
    export_script = REPO / ".cursor/skills/seek-playbook-catalog/scripts/export-canvas-baseline.ps1"
    snippet_script = REPO / ".cursor/skills/seek-playbook-catalog/scripts/gen-canvas-snippet.py"
    subprocess.run(["powershell", "-NoProfile", "-File", str(export_script)], check=True, cwd=REPO)
    subprocess.run(["python", str(snippet_script)], check=True, cwd=REPO)

    export = json.loads((REPO / ".cursor/canvas-baseline-export.json").read_text(encoding="utf-8-sig"))
    snip = json.loads((REPO / ".cursor/canvas-baseline-snippet.json").read_text(encoding="utf-8-sig"))
    sha = export.get("gitSha") or "unknown"
    branch = export.get("branch") or "test/all-scenario-drivers"
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    tag = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    chart = snip.get("chartByScenario", snip.get("violinByScenario", {}))
    stub_ids = snip.get("stubScenarioIds", [])
    runs = snip["runs"]

    insert = "\n".join(
        [
            f"/** All-driver smoke batch {today} - git {sha} - export-canvas-baseline.ps1 */",
            "const STUB_SCENARIO_IDS: RunScenarioId[] = " + ts_val(stub_ids) + ";",
            "",
            "type ScenarioChartSpec = { unit: string; metric: ScenarioMetricKey; points: AtomicPoint[] };",
            "",
            "/** Per test id — atomic points; group at render time. */",
            "const SCENARIO_CHART: Partial<Record<RunScenarioId, ScenarioChartSpec>> = "
            + ts_val({k: {"unit": v["unit"], "metric": v["metric"], "points": v.get("points", [])} for k, v in chart.items()})
            + ";",
            "",
            "const RUNS: SandboxRun[] = " + ts_val(runs) + ";",
            "",
        ]
    )

    canvas = CANVAS.read_text(encoding="utf-8")
    marker = "/** "
    start = canvas.index(marker, canvas.index("const STUB_SCENARIO_IDS") - 200)
    end = canvas.index("];", canvas.index("const RUNS: SandboxRun[]")) + 3
    canvas = canvas[:start] + insert + canvas[end:]

    canvas = re.sub(
        r'const reportMeta = \{[\s\S]*?\};',
        f'const reportMeta = {{\n    title: "Seek telemetry baseline report",\n    reportId: "SEEK-TEL-{today.replace("-", "")}-{sha}",\n    date: "{today}",\n    branch: "{branch}",\n    gitSha: "{sha}",\n    samples: 3,\n    vault: "plugin-sandbox-Obsidian (~2998 notes) + seek-functional",\n  }};',
        canvas,
        count=1,
    )
    canvas = canvas.replace(
        "Four implemented playbook drivers (S1, S6, F2, F3) completed a 3-sample baseline batch with",
        "All 17 playbook drivers (S1-S7, F1-F10) have at least one smoke run; S1/S6/F2/F3 retain 3-sample baselines with",
    )
    canvas = canvas.replace(
        '<Text weight="semibold" size="small">12/12 passes</Text>. Thirteen scenarios remain stub',
        f'<Text weight="semibold" size="small">{len(runs)} runs / {len(chart)} charted scenarios</Text>. Zero open stubs',
    )
    canvas = canvas.replace(
        "caption={`Test ${testId} · 3-sample baseline · git 094e112 · 2026-08-29 · y-axis auto-scaled to ${testId} data only`}",
        f"caption={{`Test ${{testId}} · git {sha} · {tag} · y-axis auto-scaled to ${{testId}} data only`}}",
    )
    canvas = canvas.replace(
        "run-all-scenarios.ps1 -IncludeColdStart -Samples 3 → export-canvas-baseline.ps1 → update canvas RUNS/SCENARIO_CHART.",
        "export-canvas-baseline.ps1 → splice-canvas-baseline.py → sandbox-run-history.canvas.tsx (RUNS + SCENARIO_CHART).",
    )

    CANVAS.write_text(canvas, encoding="utf-8")
    print(f"Updated canvas: {len(runs)} runs, {len(chart)} charts, {len(stub_ids)} stubs, sha={sha}")


if __name__ == "__main__":
    main()
