---
name: seek-dev-log
description: Writes and updates Seek's append-only living-memory log in a grep-friendly key: value format. Use when the user asks for a dev log, living memory, investigation recap, RCA writeup, or to record what was found/fixed. Record file is dev-log-history.md — not this skill.
---

# Seek dev log

How to write. Record: `dev-log-history.md` (repo root). Process stays in this skill.

## When

End of investigation, RCA, deploy/probe loop, or user says log / living memory / recap. One dated entry per finding or fix batch. Same day can have many entries.

## Agent read path (do this first)

```
rg "^id:" dev-log-history.md
rg "^status: open" dev-log-history.md
rg "^tag: <topic>" dev-log-history.md
rg "^file: <path>" dev-log-history.md
rg "^sym: <name>" dev-log-history.md
```

Then read the matching `##` block only. Do not ingest the whole file unless asked.

## Grep contract

History is line-oriented. Prefixes are stable, lowercase, start of line.

| Prefix | Repeat? | Value |
|--------|---------|-------|
| `id:` | no | `YYYY-MM-DD-slug` |
| `date:` | no | `YYYY-MM-DD` |
| `status:` | no | `open` or `done` |
| `tag:` | yes | one token (`startup`, `webgpu`, `cli`, `git`) |
| `file:` | yes | repo-relative path |
| `sym:` | yes | function/type/const name |
| `cmd:` | yes | CLI command token |
| `bug:` | yes | bug id / crbug |
| `commit:` | yes | conventional subject or hash |
| `found:` | yes | one fact |
| `rca:` | yes | one cause |
| `did:` | yes | one action |
| `open:` | yes | leftover; omit if none |
| `was-wrong:` | yes | kills an older RCA; cite `id:` |

Never put a path, symbol, or tag only inside prose. Also emit `file:` / `sym:` / `tag:` for it.

No tables, no bullets, no wrapping identifiers across lines. Caveman on `found:` / `rca:` / `did:` / `open:` only.

## Standing vs entries

**Standing** (top): current truth. Edit in place. Same prefixes. `open:` here = still unresolved now. `exclude:` = topics this log does not cover.

**Entries**: append-only, oldest first, new work at **bottom**. Never rewrite an old entry. Status in an old entry stays as it was that day; move leftover work to Standing `open:` and/or a new entry.

## New entry (paste at bottom)

```
## YYYY-MM-DD slug

id: YYYY-MM-DD-slug
date: YYYY-MM-DD
status: open
tag: topic
file: src/example.ts
sym: exampleFn
found: one fact
rca: one cause
did: one action
open: leftover
```

Slug = lowercase hyphenated, unique that day. Date from `user_info` today.

## After writing

Patch Standing: branch, `file:`/`sym:` pointers, `open:` leftovers. One line per fact. Do not copy the whole entry.

Do not commit unless asked.
If `dev-log-readme.md` exists, ignore it. Do not recreate it.
