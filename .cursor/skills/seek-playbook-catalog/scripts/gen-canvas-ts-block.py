import json
from pathlib import Path

repo = Path(__file__).resolve().parents[4]
snip = json.loads((repo / ".cursor/canvas-baseline-snippet.json").read_text(encoding="utf-8"))

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
            key = k if k.isidentifier() else json.dumps(k)
            lines.append(f"{sp}  {key}: {ts_val(val, indent + 1)}")
        return "{\n" + ",\n".join(lines) + ",\n" + sp + "}"
    return json.dumps(v)

stub_ids = snip["stubScenarioIds"]
print("/** 3-sample baseline batch 2026-08-29 · git 094e112 · export-canvas-baseline.ps1 */")
print("const STUB_SCENARIO_IDS: RunScenarioId[] = " + ts_val(stub_ids) + ";")
print("")
print("type ScenarioViolinSpec = { unit: string; metric: ScenarioMetricKey; series: { label: string; values: number[] }[] };")
print("")
print("/** Y-axis range is scoped per test id (one chart per scenario). */")
print("const SCENARIO_VIOLIN: Partial<Record<RunScenarioId, ScenarioViolinSpec>> = " + ts_val({
    k: {
        "unit": v["unit"],
        "metric": v["metric"],
        "series": v["series"],
    }
    for k, v in snip["violinByScenario"].items()
}) + ";")
print("")

# Map metric strings to ScenarioMetricKey - fix in TS manually if needed
runs = snip["runs"]
print("const RUNS: SandboxRun[] = " + ts_val(runs) + ";")
