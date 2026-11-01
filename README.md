# pi-sync (vibecoded)

Keep your [Pi](https://pi.dev) agent setup — settings, models, MCP servers,
extensions, skills, prompts, themes, memory — in **one private git repo**, and
deploy it to any machine with a single command.

```
machine A ~/.pi/agent ──/sync-push──▶ private repo ──/sync-pull──▶ machine B ~/.pi/agent
```

- One TypeScript file, **no runtime dependencies** (uses only `node:*`, Pi's own
  API, and `typebox`).
- `push` mirrors your selection into the repo (deletions propagate, no stale
  files).
- `pull` deploys the repo over the local agent dir and **backs up** everything
  it replaces.
- Secrets are excluded by default (`auth.json`, `models-store.json`).
- Skills are synced from both the agent dir (`skills/`) and the shared
  **`~/.agents/skills`** location that Pi also loads from.
- `sessions/`, `install/`, `npm/`, `bin/` and the sync mirror itself are never
  touched.
- Every push writes `.pi-sync/bootstrap.sh` into the repo, so a machine **without
  Pi** can still be bootstrapped with `sh bootstrap.sh` (extra paths included).

---

## Install

### With Pi (recommended, updatable)

```bash
pi install git:github.com/Tehnocrat/pi-sync-vibecoded
```

Pin a tag/commit if you like:

```bash
pi install git:github.com/Tehnocrat/pi-sync-vibecoded@v1.0.0
```

Try it without touching your settings:

```bash
pi -e git:github.com/Tehnocrat/pi-sync-vibecoded
```

Update later with `pi update --extensions`; remove with
`pi remove git:github.com/Tehnocrat/pi-sync-vibecoded`.

### Without Pi (plain file copy)

```bash
git clone https://github.com/Tehnocrat/pi-sync-vibecoded.git
cd pi-sync-vibecoded
sh install.sh          # copies extensions/pi-sync.ts into ~/.pi/agent/extensions
```

Or just copy [`extensions/pi-sync.ts`](extensions/pi-sync.ts) into
`$PI_CODING_AGENT_DIR/extensions/` (default `~/.pi/agent/extensions/`).

Restart Pi or run `/reload` afterwards.

---

## Quick start

```bash
# 1. Create an empty PRIVATE repo, e.g. github.com/you/pi-config
# 2. In Pi:
/sync-init https://github.com/you/pi-config.git
/sync-push "initial config"

# 3. On another machine with the extension installed:
/sync-pull
```

`/sync-init` writes `~/.pi/agent/pi-sync.json` with sane defaults. Edit it to
choose exactly what gets synced.

On a brand-new machine that does not even have the extension yet:

```bash
git clone https://github.com/you/pi-config.git /tmp/pi-config
sh /tmp/pi-config/.pi-sync/bootstrap.sh
```

---

## Commands

| Command | What it does |
|---|---|
| `/sync` | Status + menu to push or pull |
| `/sync-init [repo]` | Create `pi-sync.json` (optionally with a repo URL) |
| `/sync-status` | Show mirror branch / dirty state / HEAD |
| `/sync-push [message]` | Copy local config → repo, commit, push |
| `/sync-pull [repo]` | Fetch repo → deploy into the agent dir (with backup) |

Tool equivalent (usable by the agent):

```jsonc
pi_sync({ "action": "status" })          // or "push" / "pull"
pi_sync({ "action": "push", "message": "add theme" })
pi_sync({ "action": "pull", "repo": "https://github.com/you/pi-config.git" })
```

---

## Configuration (`~/.pi/agent/pi-sync.json`)

```jsonc
{
  "repo": "git@github.com:you/pi-config.git",   // required (or PI_SYNC_REPO)
  "branch": "main",

  // Paths relative to the agent dir (or absolute). Directories are recursive.
  "include": [
    "settings.json", "keybindings.json", "mcp.json", "models.json",
    "AGENTS.md", "AGENTS.override.md", "APPEND_SYSTEM.md", "SYSTEM.md", "CLAUDE.md",
    "extensions/", "skills/", "prompts/", "themes/", "memory/",
    "pi-sync.json"                              // keep the manifest in the repo
  ],

  // Sync paths that live outside the agent dir. Defaults to the shared
  // Agent Skills location, so `~/.agents/skills` travels with the config.
  // An explicit [] disables extra paths.
  "extra": [
    { "path": "~/.agents/skills", "as": "extra/agents-skills" }
  ],

  // Basename globs (`*`, `?`), NOT gitignore syntax.
  "exclude": ["node_modules", ".git", ".DS_Store", "*.log", "*.tmp", "recovery", "backups"],

  "includeSecrets": false,   // true adds auth.json + models-store.json (plaintext!)
  "autoPushOnExit": false,   // push when a session shuts down
  "autoPullOnStart": false,  // pull on session start (only if the mirror exists)
  "commitMessage": ""        // optional trailer appended to every commit body
}
```

Repo resolution order: explicit argument (`/sync-pull <url>`, tool `repo`) →
`pi-sync.json` → `PI_SYNC_REPO` env var. The fallbacks let a fresh machine pull
before it has a config.

When `extra` is omitted entirely, pi-sync defaults it to
`~/.agents/skills` → `extra/agents-skills`. Existing configs that spell out
`"extra": []` keep syncing nothing extra — set the entry explicitly (or rerun
`/sync-init`) to pick up shared skills.

### Where state lives

| Path | Purpose |
|---|---|
| `~/.pi/agent/sync/repo` | disposable mirror clone of your config repo |
| `~/.pi/agent/sync/backups/<timestamp>/` | pre-pull copies of replaced files (never pruned) |

---

## Safety notes

- **Push is a true mirror.** Everything in the mirror except `.git` is deleted
  before copying, so renamed/removed files actually disappear from the repo.
- **Push refuses to force.** If the remote diverged (another machine pushed),
  the ff-only merge fails loudly instead of clobbering history.
- **Pull replaces, it does not merge.** Local-only files *inside synced
  directories* are removed — they are saved in the backup first.
- **`includeSecrets: true` puts plaintext keys in git history.** Only use it
  with a repo you would trust with your credentials. It is off by default.
- Git auth is whatever your `git`/SSH setup already has; terminal prompts are
  disabled so failures surface as errors instead of hangs.

---

## Development

Design notes, invariants, code map and the test recipe live in
[`docs/pi-sync.memo.md`](docs/pi-sync.memo.md). Read it before changing push or
pull semantics.

```bash
git clone https://github.com/Tehnocrat/pi-sync-vibecoded.git
cd pi-sync-vibecoded
pi -e .                     # load the local package for one session
```

## License

MIT — see [LICENSE](LICENSE).
