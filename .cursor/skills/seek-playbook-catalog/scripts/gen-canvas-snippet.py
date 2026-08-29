import json
from pathlib import Path

repo = Path(__file__).resolve().parents[4]
d = json.loads((repo / ".cursor/canvas-baseline-export.json").read_text(encoding="utf-8-sig"))

vault_map = {"S6": "seek-functional", "F2": "seek-functional", "F3": "seek-functional", "S1": "plugin-sandbox-Obsidian"}
name_map = {"S6": "Known-item early paint", "F2": "Warm plugin reload", "F3": "Headless search", "S1": "Cold start"}

runs = []
for r in d["runs"]:
    sid = r["scenarioId"]
    si = r["sampleIndex"]
    m = r["metrics"]
    dur = r.get("durationSec")
    if dur is None and m.get("T_search_ms"):
        dur = round(m["T_search_ms"] / 1000, 2)
    if sid == "S1":
        dur = m["T_start_ms"] / 1000
    if sid == "F2":
        dur = m["T_first_good_ms"] / 1000
    entry = {
        "id": r["id"],
        "scenarioId": sid,
        "sampleIndex": si,
        "shortLabel": f"{sid} sample {si}",
        "dateLabel": "2026-08-29 19:02 local (3-sample batch)",
        "dateStart": "2026-08-29T19:02:00",
        "vault": vault_map.get(sid, "seek-functional"),
        "vaultNoteCount": 2998,
        "nature": f"3-sample baseline · {name_map.get(sid, sid)}",
        "protocol": "correct",
        "protocolSteps": ["run-all-scenarios.ps1 -IncludeColdStart -Samples 3"],
        "outcome": r["outcome"],
        "gitSha": d["gitSha"],
        "durationSec": dur,
        "metrics": m,
        "artifacts": r.get("artifacts") or {},
    }
    if sid in ("S1", "F2"):
        entry["chunks"] = 10942
        entry["filesIndexed"] = 2998
        entry["uiHealth"] = "ok"
    runs.append(entry)

# S6: per-sample violins for clearer deviation view
v = dict(d["violinByScenario"])
if "S6" in v:
    partials = v["S6"]["series"][0]["values"]
    v["S6"]["series"] = [
        {"label": f"sample {i + 1}", "values": [partials[i]]} for i in range(len(partials))
    ]

out = repo / ".cursor/canvas-baseline-snippet.json"
out.write_text(json.dumps({"runs": runs, "violinByScenario": v, "stubScenarioIds": d["stubScenarioIds"]}, indent=2), encoding="utf-8")
print(f"wrote {out}")
