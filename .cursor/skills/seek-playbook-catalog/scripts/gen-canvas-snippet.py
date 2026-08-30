import json
from datetime import datetime, timezone
from pathlib import Path

repo = Path(__file__).resolve().parents[4]
d = json.loads((repo / ".cursor/canvas-baseline-export.json").read_text(encoding="utf-8-sig"))

vault_map = {
    "S1": "plugin-sandbox-Obsidian",
    "S2": "Obsidian",
    "S3": "Obsidian",
    "S4": "Obsidian",
    "S5": "plugin-sandbox-Obsidian",
    "S6": "seek-functional",
    "S7": "seek-functional",
    "F1": "plugin-sandbox-Obsidian",
    "F2": "seek-functional",
    "F3": "seek-functional",
    "F4": "seek-functional",
    "F5": "seek-functional",
    "F6": "seek-functional",
    "F7": "seek-functional",
    "F8": "plugin-sandbox-Obsidian",
    "F9": "seek-functional",
    "F10": "seek-functional",
}

name_map = {
    "S1": "Cold start",
    "S2": "Incremental indexing",
    "S3": "Startup first good",
    "S4": "Greedy hydrate",
    "S5": "Needle in haystack",
    "S6": "Known-item early paint",
    "S7": "Query supersession",
    "F1": "Cold restart → index boot",
    "F2": "Warm plugin reload",
    "F3": "Headless search",
    "F4": "Open result",
    "F5": "Insert link (CLI)",
    "F6": "Modal search UI",
    "F7": "Modal insert (Alt+Enter)",
    "F8": "Search during catch-up",
    "F9": "Modal early name paint",
    "F10": "Rapid query cancel",
}

tag = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
date_start = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")

runs = []
for r in d["runs"]:
    sid = r["scenarioId"]
    si = r.get("sampleIndex", 1)
    m = r.get("metrics") or {}
    dur = r.get("durationSec")
    if dur is None:
        for key in ("T_search_ms", "T_first_good_ms", "T_start_ms", "elapsedMs", "searchMs"):
            if key in m:
                dur = round(float(m[key]) / 1000, 2)
                break
        if dur is None and "namePartialMs" in m:
            dur = round(float(m["namePartialMs"]) / 1000, 2)
    entry = {
        "id": r["id"],
        "scenarioId": sid,
        "sampleIndex": si,
        "shortLabel": f"{sid} sample {si}",
        "dateLabel": f"{tag} (all-drivers batch)",
        "dateStart": date_start,
        "vault": vault_map.get(sid, "seek-functional"),
        "nature": f"Driver smoke · {name_map.get(sid, sid)}",
        "protocol": "correct",
        "protocolSteps": ["test/all-scenario-drivers: implement driver → run once → canvas"],
        "outcome": r.get("outcome", "success"),
        "gitSha": d.get("gitSha"),
        "durationSec": dur,
        "metrics": m,
        "artifacts": r.get("artifacts") or {},
    }
    if r.get("fixture"):
        entry["fixture"] = r["fixture"]
    if sid in ("S1", "F1", "F2", "F8"):
        entry["uiHealth"] = "ok"
    runs.append(entry)

chart = dict(d.get("chartByScenario", d.get("violinByScenario", {})))

out = repo / ".cursor/canvas-baseline-snippet.json"
out.write_text(
    json.dumps(
        {
            "runs": runs,
            "chartByScenario": chart,
            "stubScenarioIds": d.get("stubScenarioIds", []),
        },
        indent=2,
    ),
    encoding="utf-8",
)
print(f"wrote {out} ({len(runs)} runs, {len(chart)} charts, {len(d.get('stubScenarioIds', []))} stubs)")
