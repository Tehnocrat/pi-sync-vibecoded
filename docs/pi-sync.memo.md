# pi-sync — memo

Companion notes for `pi-sync.ts`. Read the file header first; this memo explains
*why* it is built the way it is and what to watch out for when changing it.

## 1. What it does

Moves a personal Pi setup between machines through a private git repo:

```
machine A ~/.pi/agent ──push──▶ private repo ──pull──▶ machine B ~/.pi/agent
```

- `push`: copy selected local paths into a mirror clone, commit, push.
- `pull`: fetch the repo, then copy its contents over the local agent dir
  (backing up anything replaced first).
- `status`: show the mirror's branch/dirty/head state.

Secrets are opt-in only (`includeSecrets`). Sessions, installs, npm caches and
runtime logs are never touched.

## 2. Files and state

| Path | Role |
|---|---|
| `~/.pi/agent/extensions/pi-sync.ts` | the whole extension (single file, no deps) |
| `~/.pi/agent/pi-sync.json` | config + the manifest that `pull` deploys from |
| `~/.pi/agent/sync/repo` | disposable mirror clone of the private repo |
| `~/.pi/agent/sync/backups/<ts>/` | pre-pull copies of replaced paths |
| `<repo>/.pi-sync/bootstrap.sh` | regenerated on every push; deploys without pi |

`~/.pi/agent/sync/` is guarded in `entriesFor()` so the mirror can never sync
itself (important if someone adds `"include": ["."]`).

`pi-sync.json` is itself in `DEFAULT_INCLUDE`, so the repo always carries the
manifest needed by `pull` on a new machine.

## 3. Config schema

```jsonc
{
  "repo": "git@github.com:you/pi-config.git", // required (or PI_SYNC_REPO)
  "branch": "main",
  "include": ["settings.json", "extensions/", "..."], // relative to agent dir, or absolute
  "extra": [{ "path": "~/.agents/skills", "as": "extra/agents-skills" }],
  "exclude": ["node_modules", ".git", "recovery", "*.log"], // matched on basename, `*`/`?` globs
  "includeSecrets": false,      // adds auth.json + models-store.json
  "autoPushOnExit": false,      // session_shutdown -> push()
  "autoPullOnStart": false,     // session_start -> pull() if mirror exists
  "commitMessage": "optional trailer appended to every commit body"
}
```

Resolution order for `repo`: `/sync-pull <url>` / tool `repo` arg → config file
→ `PI_SYNC_REPO` env. The env/arg fallbacks exist so a bare machine can pull
before `pi-sync.json` exists.

`extra.path` semantics: `~` expands to the home dir, relative paths resolve
against the agent dir, absolute paths stay absolute (and therefore are
machine-specific — prefer `~` or relative).

## 4. Code map

```
readConfig()        config load + defaults + env/arg override
entriesFor()        SyncConfig -> [{ repoPath, absPath }], dedupes, guards state dir
copyEntry/copyDirFrom  recursive copy with exclude patterns; symlinks copied as links
git/gitOk           pi.exec wrapper; sets GIT_TERMINAL_PROMPT=0 via `env` (non-Windows)
ensureRepo          clone if missing, else fix origin URL
remoteBranchExists  fetch + rev-parse origin/<branch>
checkoutBranch      checkout existing branch or create it from origin
bootstrapScript     text of .pi-sync/bootstrap.sh (tar pipe, no rsync dependency)
withRepoManifest    pull-time overlay of include/extra/exclude from the repo's pi-sync.json
status/push/pull    the three actions (all return SyncResult)
report/errorMessage UI helpers
default export      command + tool + lifecycle registration
```

## 5. Push and pull flows (what must stay true)

**Push**

1. `ensureRepo` (clone or re-point origin).
2. `fetch`, `checkout <branch>`, and `merge --ff-only origin/<branch>`.
   *Fail instead of force-pushing* — a diverged mirror means another machine
   pushed work you have not seen.
3. **Delete everything in the mirror except `.git`.** This is what makes push a
   true mirror: removed includes, renamed files, and deleted skills propagate.
4. Copy each existing `entriesFor()` target into the mirror.
5. Rewrite `.pi-sync/bootstrap.sh`.
6. `git add -A`; if nothing is staged, report "Nothing to push".
7. Commit (`subject` + `host`/`paths` body) and `git push -u origin <branch>`.

**Pull**

1. `ensureRepo`, require the remote branch to exist.
2. `checkout -B <branch> origin/<branch>` then `reset --hard origin/<branch>`
   (the mirror is a cache; local changes there are disposable).
3. `withRepoManifest()` — deploy from the manifest *in the repo*, not the local
   one, so a fresh machine gets `extra` paths and the same include set.
4. For each repo entry: back up the local target, then replace it.
5. Report the backup path and suggest `/reload`.

Consequence of step 4: local-only files inside a synced directory are removed on
pull (they are in the backup). That is intentional "deploy" semantics; do not
switch to merge without thinking about orphaned extensions.

## 6. Invariants / gotchas

- **Mirror is disposable.** Never store user data there; push resets it.
- **Backups are never pruned.** They grow slowly; clean
  `~/.pi/agent/sync/backups/` when it matters.
- **No locking.** Two simultaneous pushes from different sessions can collide at
  the ff-only merge; the error is explicit and safe.
- **Auth is whatever git/ssh already has.** The wrapper disables terminal
  prompts, so failures surface as errors instead of hangs.
- **Empty remote repos are fine**: clone succeeds, branch is created by
  `checkout -B`, first push sets upstream.
- **`includeSecrets: true` commits plaintext keys** to the repo history. Only do
  it with a repo you would trust with your credentials.
- **Deploy never writes into `sessions/`, `install/`, `npm/`, `bin/`** because
  they are not in the default include list.
- **bootstrap.sh is generated, not hand-edited.** Edit `bootstrapScript()`.
- Pull does not reload automatically in all modes: the command offers a confirm
  (works in TUI/RPC), the tool only returns instructions.

## 7. Common modifications

- **Sync another path by default**: add to `DEFAULT_INCLUDE` (and to existing
  users' `pi-sync.json`, because a saved config overrides the defaults).
- **New secret file**: add to `SECRET_FILES`.
- **New tool action / command**: `pull`, `push`, `status` all take the same
  `Pi` + optional repo override; register in the default export and reuse
  `report()`.
- **Different deploy policy** (merge instead of replace): change the loop in
  `pull()`; keep the backup step first.
- **Auto behaviour**: `autoPushOnExit` / `autoPullOnStart` handlers at the
  bottom; keep them fail-safe (they already swallow errors).
- **Exclude rules** are basename globs, not gitignore syntax. `*.log` works,
  `dir/**` does not.

## 8. Testing recipe

Fast, no model calls:

1. `jiti` + alias map to load the TS file:
   `@earendil-works/pi-coding-agent -> <pi install>/dist/index.js`,
   `typebox -> <pi install>/node_modules/typebox/build/index.mjs`.
2. Mock `pi`: capture `registerCommand`/`registerTool`/`on`, and implement
   `exec` with `child_process.execFile` returning `{stdout, stderr, code}`.
3. Point `PI_CODING_AGENT_DIR` at a temp dir, `git init --bare -b main` a local
   remote, write a minimal `pi-sync.json`, then call
   `tools.pi_sync.execute("1", { action: "push" })`, inspect `git ls-tree`,
   switch `PI_CODING_AGENT_DIR` to a second temp dir, and call `pull` with the
   `repo` argument to exercise the bootstrap path.
4. Assert `auth.json` and `memory/recovery` never appear in the tree.

Real-pi smoke test (RPC, no LLM needed):

```sh
(printf '{"id":"r1","type":"prompt","message":"/sync-status"}\n'; sleep 5) |
  PI_CODING_AGENT_DIR=/tmp/agent pi --mode rpc --no-session --no-mcp \
    --no-extensions --no-skills -e ~/.pi/agent/extensions/pi-sync.ts
```

Keep stdin open (`sleep`) — closing it makes pi exit and the command appears to
produce no output.

## 9. Open ideas

- Lock file (`proper-lockfile` is already a pi dependency) around push/pull.
- Prune old backups (keep last N).
- Optional age/gpg encryption for `includeSecrets`, or per-path secret mapping.
- `--dry-run` / preview diff before deploy.
- A `verify` action that compares local vs repo without touching either.
