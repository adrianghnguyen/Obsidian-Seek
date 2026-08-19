---
name: deploy-branch-to-vault
description: Checks out a git branch for the Seek Obsidian plugin, proposing candidates when several match, then builds and copies main.js, manifest.json, and styles.css into the local Obsidian vault. Use when the user asks to pull a branch into the vault, deploy Seek to Obsidian, install a fix or feature branch locally, or copy the plugin to the vault.
---

# Deploy a branch to the Obsidian vault

Pull a branch into this repo, build Seek, and copy it to the Windows vault. Do not skip verify. Do not commit or push unless asked.

Vault: `C:\Obsidian\.obsidian\plugins\seek\`
Reload: `obsidian plugin:reload id=seek vault=Obsidian`

## Git

Prefix every git command with `-c safe.directory=<repo-root>` if Git reports dubious ownership. Never run `git config --global`.

Dirty working tree → stop and ask. Never discard local changes.

After checkout, call `SetActiveBranch` for this repo.

## 1. Find the branch

`git fetch origin --prune` first.

**Named branch** (user said `fix-foo` or `origin/fix-foo`) → use it.

**Otherwise collect candidates**, in order:

1. Conversation / cloud-agent branch (`fix-*`, `cursor/*`, recent transcript)
2. Current local branch if it is not `main`
3. Recent `origin` heads that are not `main`: `fix-*`, `feature/*`, `cursor/*`

Rank by name match to the user's words, then recency.

- **One clear winner** → check it out and say which branch.
- **Several plausible** → list **at most 3** (name, last commit subject, age). Ask which, and whether they want more. Do not check out until they pick.
- **None** → stop.

Checkout:

```powershell
git -c safe.directory=<repo-root> checkout -B <branch> origin/<branch>
```

## 2. Build

`npm ci` only if `package-lock.json` changed or `node_modules` is missing.

Then:

1. `npm run typecheck`
2. `npm test` (or the relevant subset)
3. `npm run build`

Stop on failure.

Do not commit `main.js`.

## 3. Copy and reload

```powershell
Copy-Item -Force main.js, manifest.json, styles.css C:\Obsidian\.obsidian\plugins\seek\
```

- `manifest.json` **unchanged** vs vault copy → `obsidian plugin:reload id=seek vault=Obsidian`
- `manifest.json` **changed** → `obsidian restart vault=Obsidian` (reload is not enough)

If running from WSL, copy to `/mnt/c/Obsidian/.obsidian/plugins/seek/`.

## 4. Verify

Required: repo and vault `main.js` hashes match (`Get-FileHash`).

Also grep the vault `main.js` for a string unique to this branch, or:

```powershell
obsidian eval vault=Obsidian code="JSON.stringify({id:app.plugins.plugins.seek?.manifest?.id,version:app.plugins.plugins.seek?.manifest?.version,enabled:!!app.plugins.plugins.seek})"
```

Tell the user to **close and reopen** affected modals. If CSS or layout looks stale, use `obsidian restart`.
