/**
 * pi-sync — sync your Pi agent config to a private git repo and deploy it elsewhere.
 *
 * What it syncs (configurable): settings, models, mcp, keybindings, AGENTS/SYSTEM
 * files, extensions/, skills/, prompts/, themes/, memory/ — plus optional extra
 * paths such as ~/.agents/skills.
 *
 * It never touches ~/.pi/agent/sessions, install/, npm/, bin/ or auth.json
 * (auth.json only when `includeSecrets: true`).
 *
 * Configuration lives in `<agent-dir>/pi-sync.json`. Run `/sync-init` to create it.
 *
 *   {
 *     "repo": "git@github.com:you/pi-config.git",
 *     "branch": "main",
 *     "include": ["settings.json", "models.json", "mcp.json", "keybindings.json",
 *                 "AGENTS.md", "APPEND_SYSTEM.md", "SYSTEM.md",
 *                 "extensions/", "skills/", "prompts/", "themes/", "memory/",
 *                 "pi-sync.json"],
 *     "extra": [{ "path": "~/.agents/skills", "as": "extra/agents-skills" }],
 *     "exclude": ["node_modules", ".git", "recovery", "*.log", ".DS_Store"],
 *     "includeSecrets": false,
 *     "autoPushOnExit": false,
 *     "autoPullOnStart": false
 *   }
 *
 * Commands:
 *   /sync                 status + pick push/pull
 *   /sync-init [repo]     create pi-sync.json
 *   /sync-status          show status
 *   /sync-push [message]  copy local files into the repo, commit, push
 *   /sync-pull            fetch the repo and deploy it into the agent dir
 *
 * Tool: pi_sync({ action: "status" | "push" | "pull", message?: string })
 *
 * Bootstrapping a new machine (no extension installed yet): every push writes
 * `.pi-sync/bootstrap.sh` into the repo; run it with `sh bootstrap.sh` to deploy
 * everything into $PI_CODING_AGENT_DIR (default ~/.pi/agent).
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Pi = ExtensionAPI;

interface SyncEntry {
	/** Path inside the git repo. */
	repoPath: string;
	/** Absolute local path. */
	absPath: string;
}

interface SyncConfig {
	repo: string;
	branch: string;
	include: string[];
	extra: Array<{ path: string; as: string }>;
	exclude: string[];
	includeSecrets: boolean;
	autoPushOnExit: boolean;
	autoPullOnStart: boolean;
	/** Extra commit message lines appended to the auto-generated message. */
	commitMessage?: string;
}

const GIT_TIMEOUT = 120_000;

const DEFAULT_INCLUDE = [
	"settings.json",
	"keybindings.json",
	"mcp.json",
	"models.json",
	"AGENTS.md",
	"AGENTS.override.md",
	"APPEND_SYSTEM.md",
	"SYSTEM.md",
	"CLAUDE.md",
	"extensions/",
	"skills/",
	"prompts/",
	"themes/",
	"memory/",
	"pi-sync.json",
];

const DEFAULT_EXCLUDE = [
	"node_modules",
	".git",
	".DS_Store",
	"*.log",
	"*.tmp",
	"recovery",
	"backups",
];

const SECRET_FILES = ["auth.json", "models-store.json"];

/* ------------------------------------------------------------------ */
/* config                                                              */
/* ------------------------------------------------------------------ */

function agentDir(): string {
	return getAgentDir();
}

function configPath(): string {
	return path.join(agentDir(), "pi-sync.json");
}

function stateDir(): string {
	return path.join(agentDir(), "sync");
}

async function readConfig(repoOverride?: string): Promise<SyncConfig> {
	const p = configPath();
	const defaults = {
		branch: "main",
		include: DEFAULT_INCLUDE,
		extra: [] as Array<{ path: string; as: string }>,
		exclude: DEFAULT_EXCLUDE,
		includeSecrets: false,
		autoPushOnExit: false,
		autoPullOnStart: false,
	};
	let parsed: Partial<SyncConfig>;
	try {
		parsed = JSON.parse(await fsp.readFile(p, "utf8")) as Partial<SyncConfig>;
	} catch (err) {
		// A fresh machine can bootstrap from PI_SYNC_REPO=... alone.
		if (repoOverride || process.env.PI_SYNC_REPO) parsed = {};
		else if ((err as NodeJS.ErrnoException).code === "ENOENT")
			throw new Error(
				`No pi-sync config at ${p}. Run /sync-init <git-repo-url>, create the file, or launch pi with PI_SYNC_REPO=<url> to bootstrap.`,
			);
		else throw new Error(`Invalid JSON in ${p}: ${(err as Error).message}`);
	}
	const repo = (repoOverride || parsed.repo || process.env.PI_SYNC_REPO || "").trim();
	if (!repo) throw new Error(`${p} is missing "repo" (the private git URL).`);
	return {
		repo,
		branch: parsed.branch?.trim() || defaults.branch,
		include:
			Array.isArray(parsed.include) && parsed.include.length > 0 ? parsed.include : defaults.include,
		extra: Array.isArray(parsed.extra) ? parsed.extra : defaults.extra,
		exclude:
			Array.isArray(parsed.exclude) && parsed.exclude.length > 0 ? parsed.exclude : defaults.exclude,
		includeSecrets: parsed.includeSecrets === true,
		autoPushOnExit: parsed.autoPushOnExit === true,
		autoPullOnStart: parsed.autoPullOnStart === true,
		commitMessage: typeof parsed.commitMessage === "string" ? parsed.commitMessage : undefined,
	};
}

function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
	return p;
}

function entriesFor(cfg: SyncConfig): SyncEntry[] {
	const out: SyncEntry[] = [];
	const seen = new Set<string>();
	const guard = path.resolve(stateDir()) + path.sep;
	const push = (repoPath: string, absPath: string) => {
		const key = path.resolve(absPath);
		if (seen.has(key)) return;
		// Never sync the mirror/backup state into itself.
		if (key === path.resolve(agentDir()) || key === path.resolve(stateDir()) || key.startsWith(guard)) return;
		seen.add(key);
		out.push({ repoPath: repoPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""), absPath });
	};
	for (const item of cfg.include) {
		if (typeof item !== "string" || !item.trim()) continue;
		push(item, path.isAbsolute(item) ? item : path.join(agentDir(), item));
	}
	if (cfg.includeSecrets) for (const f of SECRET_FILES) push(f, path.join(agentDir(), f));
	for (const extra of cfg.extra) {
		if (!extra?.path || !extra?.as) continue;
		push(extra.as, path.resolve(agentDir(), expandHome(extra.path)));
	}
	return out;
}

function repoDir(cfg: SyncConfig): string {
	return path.join(stateDir(), "repo");
}

/* ------------------------------------------------------------------ */
/* fs helpers                                                          */
/* ------------------------------------------------------------------ */

function compileExcludes(patterns: string[]): RegExp[] {
	return patterns.map(
		(p) =>
			new RegExp(
				`^${p
					.replace(/[.+^${}()|[\]\\]/g, "\\$&")
					.replace(/\*/g, ".*")
					.replace(/\?/g, ".")}$`,
			),
	);
}

function isExcluded(name: string, exclude: RegExp[]): boolean {
	return exclude.some((re) => re.test(name));
}

async function copyDirFrom(src: string, dest: string, exclude: RegExp[], depth = 0): Promise<void> {
	if (depth > 40) return;
	await fsp.mkdir(dest, { recursive: true });
	for (const ent of await fsp.readdir(src, { withFileTypes: true })) {
		if (isExcluded(ent.name, exclude)) continue;
		const s = path.join(src, ent.name);
		const d = path.join(dest, ent.name);
		if (ent.isSymbolicLink()) {
			const target = await fsp.readlink(s);
			await fsp.rm(d, { recursive: true, force: true });
			await fsp.symlink(target, d).catch(() => undefined);
		} else if (ent.isDirectory()) {
			await copyDirFrom(s, d, exclude, depth + 1);
		} else if (ent.isFile()) {
			await fsp.mkdir(path.dirname(d), { recursive: true });
			await fsp.copyFile(s, d);
			const mode = (await fsp.stat(s)).mode;
			await fsp.chmod(d, mode & 0o777).catch(() => undefined);
		}
	}
}

async function copyEntry(src: string, dest: string, exclude: RegExp[]): Promise<void> {
	let st;
	try {
		st = await fsp.stat(src);
	} catch {
		return;
	}
	if (st.isDirectory()) {
		await fsp.rm(dest, { recursive: true, force: true });
		await copyDirFrom(src, dest, exclude);
	} else {
		await fsp.rm(dest, { recursive: true, force: true });
		await fsp.mkdir(path.dirname(dest), { recursive: true });
		await fsp.copyFile(src, dest);
		await fsp.chmod(dest, st.mode & 0o777).catch(() => undefined);
	}
}

async function exists(p: string): Promise<boolean> {
	try {
		await fsp.stat(p);
		return true;
	} catch {
		return false;
	}
}

/* ------------------------------------------------------------------ */
/* git                                                                 */
/* ------------------------------------------------------------------ */

interface CmdResult {
	stdout: string;
	stderr: string;
	code: number;
}

async function git(pi: Pi, args: string[], cwd: string, timeout = GIT_TIMEOUT): Promise<CmdResult> {
	const res =
		process.platform === "win32"
			? await pi.exec("git", args, { cwd, timeout })
			: await pi.exec("env", ["GIT_TERMINAL_PROMPT=0", "git", ...args], { cwd, timeout });
	return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", code: res.code };
}

async function gitOk(pi: Pi, args: string[], cwd: string, timeout = GIT_TIMEOUT): Promise<CmdResult> {
	const res = await git(pi, args, cwd, timeout);
	if (res.code !== 0) {
		const detail = (res.stderr || res.stdout).trim().split("\n").slice(-6).join("\n");
		throw new Error(`git ${args.join(" ")} failed (exit ${res.code}):\n${detail}`);
	}
	return res;
}

async function ensureRepo(pi: Pi, cfg: SyncConfig): Promise<string> {
	const dir = repoDir(cfg);
	if (await exists(path.join(dir, ".git"))) {
		await gitOk(pi, ["remote", "set-url", "origin", cfg.repo], dir);
		return dir;
	}
	await fsp.mkdir(path.dirname(dir), { recursive: true });
	const res = await git(pi, ["clone", cfg.repo, dir], path.dirname(dir));
	if (res.code !== 0) {
		// Empty repo clone can still succeed; a real failure means auth/URL problems.
		const detail = (res.stderr || res.stdout).trim();
		throw new Error(`Could not clone ${cfg.repo}:\n${detail}`);
	}
	return dir;
}

async function remoteBranchExists(pi: Pi, cfg: SyncConfig, dir: string): Promise<boolean> {
	await git(pi, ["fetch", "origin", cfg.branch], dir);
	const res = await git(pi, ["rev-parse", "--verify", `origin/${cfg.branch}`], dir);
	return res.code === 0;
}

async function checkoutBranch(pi: Pi, cfg: SyncConfig, dir: string, hasRemote: boolean): Promise<void> {
	if (hasRemote) {
		const local = await git(pi, ["rev-parse", "--verify", `refs/heads/${cfg.branch}`], dir);
		if (local.code === 0) await gitOk(pi, ["checkout", cfg.branch], dir);
		else await gitOk(pi, ["checkout", "-B", cfg.branch, `origin/${cfg.branch}`], dir);
	} else {
		await gitOk(pi, ["checkout", "-B", cfg.branch], dir);
	}
}

/* ------------------------------------------------------------------ */
/* bootstrap script                                                    */
/* ------------------------------------------------------------------ */

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function bootstrapScript(cfg: SyncConfig): string {
	return `#!/bin/sh
# Generated by pi-sync. Deploys this Pi config repo into the local agent dir.
set -eu
REPO=${shellQuote(cfg.repo)}
BRANCH=${shellQuote(cfg.branch)}
DEST="\${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
TMP="\$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM
mkdir -p "$DEST"
git clone --depth 1 --branch "$BRANCH" "$REPO" "$TMP/repo"
( cd "$TMP/repo" && tar -cf - --exclude=.git --exclude=.pi-sync . ) | ( cd "$DEST" && tar -xf - )
printf 'Deployed Pi config to %s\\n' "$DEST"
printf 'Start pi and run /reload (or just start it) to load the new resources.\\n'
`;
}

/* ------------------------------------------------------------------ */
/* core actions                                                        */
/* ------------------------------------------------------------------ */

/** Overlay include/extra/exclude from the manifest committed in the repo. */
async function withRepoManifest(cfg: SyncConfig, dir: string): Promise<SyncConfig> {
	try {
		const raw = JSON.parse(await fsp.readFile(path.join(dir, "pi-sync.json"), "utf8")) as Partial<SyncConfig>;
		return {
			...cfg,
			include: Array.isArray(raw.include) && raw.include.length > 0 ? raw.include : cfg.include,
			extra: Array.isArray(raw.extra) ? raw.extra : cfg.extra,
			exclude: Array.isArray(raw.exclude) && raw.exclude.length > 0 ? raw.exclude : cfg.exclude,
		};
	} catch {
		return cfg;
	}
}

export interface SyncResult {
	ok: boolean;
	summary: string;
}

async function status(pi: Pi, repoOverride?: string): Promise<SyncResult> {
	const cfg = await readConfig(repoOverride).catch((err: Error) => err);
	if (cfg instanceof Error) return { ok: false, summary: cfg.message };
	const dir = repoDir(cfg);
	const lines = [`repo:   ${cfg.repo}`, `branch: ${cfg.branch}`, `mirror: ${dir}`];
	if (!(await exists(path.join(dir, ".git")))) {
		lines.push("state:  not cloned yet (run /sync-push or /sync-pull)");
	} else {
		const branch = await git(pi, ["status", "-sb"], dir);
		lines.push(`state:  ${(branch.stdout || "unknown").trim()}`);
		const dirty = await git(pi, ["status", "--porcelain"], dir);
		const changed = dirty.stdout.trim().split("\n").filter(Boolean);
		lines.push(`dirty:  ${changed.length} file(s)`);
		if (changed.length > 0) lines.push(...changed.slice(0, 15).map((l) => `  ${l}`));
		const log = await git(pi, ["log", "-1", "--format=%h %s (%cr)"], dir);
		lines.push(`head:   ${log.stdout.trim() || "(no commits)"}`);
	}
	const local = entriesFor(cfg).filter((e) => fs.existsSync(e.absPath));
	lines.push(`local:  ${local.length} path(s) selected`);
	return { ok: true, summary: lines.join("\n") };
}

async function push(pi: Pi, message?: string): Promise<SyncResult> {
	const cfg = await readConfig();
	const dir = await ensureRepo(pi, cfg);
	const hasRemote = await remoteBranchExists(pi, cfg, dir);
	await checkoutBranch(pi, cfg, dir, hasRemote);
	if (hasRemote) {
		// Bring the mirror up to date; fail rather than silently dropping remote work.
		const pull = await git(pi, ["merge", "--ff-only", `origin/${cfg.branch}`], dir);
		if (pull.code !== 0) {
			throw new Error(
				`Mirror at ${dir} has diverged from origin/${cfg.branch}. Resolve it there (or delete the folder) and retry.\n${pull.stderr.trim()}`,
			);
		}
	}

	// Re-materialize the mirror so pushes reflect the current include list exactly.
	for (const name of await fsp.readdir(dir)) {
		if (name === ".git") continue;
		await fsp.rm(path.join(dir, name), { recursive: true, force: true });
	}

	const exclude = compileExcludes(cfg.exclude);
	const copied: string[] = [];
	for (const entry of entriesFor(cfg)) {
		if (!(await exists(entry.absPath))) continue;
		await copyEntry(entry.absPath, path.join(dir, entry.repoPath), exclude);
		copied.push(entry.repoPath);
	}

	// Keep a standalone bootstrap script in the repo for fresh machines.
	const bootDir = path.join(dir, ".pi-sync");
	await fsp.mkdir(bootDir, { recursive: true });
	await fsp.writeFile(path.join(bootDir, "bootstrap.sh"), bootstrapScript(cfg), "utf8");
	await fsp.chmod(path.join(bootDir, "bootstrap.sh"), 0o755).catch(() => undefined);

	await gitOk(pi, ["add", "-A"], dir);
	const dirty = await git(pi, ["status", "--porcelain"], dir);
	if (!dirty.stdout.trim()) {
		return { ok: true, summary: `Nothing to push. Repo is up to date (${cfg.repo}#${cfg.branch}).` };
	}

	const host = os.hostname();
	const subject = (message?.trim() || `sync from ${host}`).split("\n")[0];
	const bodyLines = [
		subject,
		"",
		`host: ${host}`,
		`paths: ${copied.join(", ")}`,
		...(cfg.commitMessage ? ["", cfg.commitMessage] : []),
	];
	await gitOk(pi, ["commit", "-m", bodyLines.join("\n")], dir);
	await gitOk(pi, ["push", "-u", "origin", cfg.branch], dir, 180_000);
	const head = await git(pi, ["log", "-1", "--format=%h %s"], dir);
	return {
		ok: true,
		summary: `Pushed ${copied.length} path(s) to ${cfg.repo}#${cfg.branch}\n${head.stdout.trim()}`,
	};
}

async function pull(pi: Pi, repoOverride?: string): Promise<SyncResult> {
	const cfg = await readConfig(repoOverride);
	const dir = await ensureRepo(pi, cfg);
	const hasRemote = await remoteBranchExists(pi, cfg, dir);
	if (!hasRemote) throw new Error(`Remote branch ${cfg.branch} does not exist yet. Push from a machine that has it.`);
	await gitOk(pi, ["checkout", "-B", cfg.branch, `origin/${cfg.branch}`], dir);
	await gitOk(pi, ["reset", "--hard", `origin/${cfg.branch}`], dir);

	// The repo carries its own manifest (pi-sync.json). Deploy from that so a fresh
	// machine gets exactly what was pushed, including extra paths.
	const deployCfg = await withRepoManifest(cfg, dir);
	const exclude = compileExcludes(deployCfg.exclude);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupRoot = path.join(stateDir(), "backups", stamp);
	const deployed: string[] = [];

	for (const entry of entriesFor(deployCfg)) {
		const src = path.join(dir, entry.repoPath);
		if (!(await exists(src))) continue;
		if (await exists(entry.absPath)) {
			await copyEntry(entry.absPath, path.join(backupRoot, entry.repoPath), exclude).catch(() => undefined);
		}
		await copyEntry(src, entry.absPath, exclude);
		deployed.push(entry.repoPath);
	}

	const backupNote = (await exists(backupRoot)) ? `\nBackup of replaced files: ${backupRoot}` : "";
	return {
		ok: true,
		summary: `Deployed ${deployed.length} path(s) into ${agentDir()}.${backupNote}\nRun /reload (or restart pi) to load deployed extensions, skills and settings.`,
	};
}

/* ------------------------------------------------------------------ */
/* extension                                                           */
/* ------------------------------------------------------------------ */

function report(ctx: ExtensionContext, result: SyncResult): void {
	const prefix = result.ok ? "" : "pi-sync: ";
	if (ctx.hasUI) ctx.ui.notify(prefix + result.summary, result.ok ? "info" : "error");
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export default function piSyncExtension(pi: ExtensionAPI) {
	pi.registerCommand("sync", {
		description: "Sync Pi config with the private git repo (status + push/pull)",
		handler: async (_args, ctx) => {
			let st: SyncResult;
			try {
				st = await status(pi);
			} catch (err) {
				ctx.ui.notify(errorMessage(err), "error");
				return;
			}
			const choice = await ctx.ui.select(`pi-sync\n\n${st.summary}`, [
				"Push local config to repo",
				"Pull repo and deploy here",
				"Refresh status",
			]);
			if (!choice) return;
			try {
				if (choice.startsWith("Push")) report(ctx, await push(pi));
				else if (choice.startsWith("Pull")) report(ctx, await pull(pi));
				else report(ctx, await status(pi));
			} catch (err) {
				ctx.ui.notify(errorMessage(err), "error");
			}
		},
	});

	pi.registerCommand("sync-init", {
		description: "Create pi-sync.json for a private git repo",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			let repo = args.trim();
			if (!repo) repo = (await ctx.ui.input("Private git repo URL", "git@github.com:you/pi-config.git"))?.trim() || "";
			if (!repo) return;
			const cfg = {
				repo,
				branch: "main",
				include: DEFAULT_INCLUDE,
				extra: [],
				exclude: DEFAULT_EXCLUDE,
				includeSecrets: false,
				autoPushOnExit: false,
				autoPullOnStart: false,
			};
			await fsp.mkdir(agentDir(), { recursive: true });
			const file = configPath();
			if (await exists(file)) {
				const overwrite = await ctx.ui.confirm("pi-sync", `${file} already exists. Overwrite it?`);
				if (!overwrite) return;
			}
			await fsp.writeFile(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
			ctx.ui.notify(`Wrote ${file}. Edit include/extra as needed, then run /sync-push.`, "info");
		},
	});

	pi.registerCommand("sync-status", {
		description: "Show pi-sync repository status",
		handler: async (_args, ctx) => {
			try {
				report(ctx, await status(pi));
			} catch (err) {
				ctx.ui.notify(errorMessage(err), "error");
			}
		},
	});

	pi.registerCommand("sync-push", {
		description: "Copy local config into the repo, commit and push",
		handler: async (args: string, ctx) => {
			try {
				report(ctx, await push(pi, args.trim() || undefined));
			} catch (err) {
				ctx.ui.notify(errorMessage(err), "error");
			}
		},
	});

	pi.registerCommand("sync-pull", {
		description: "Fetch the repo and deploy it into this machine's agent dir (/sync-pull [repo-url]) ",
		handler: async (args: string, ctx) => {
			try {
				const result = await pull(pi, args.trim() || undefined);
				report(ctx, result);
				if (result.ok && ctx.hasUI) {
					const reload = await ctx.ui.confirm("pi-sync", "Deployed. Reload pi now?");
					if (reload) await ctx.reload();
				}
			} catch (err) {
				ctx.ui.notify(errorMessage(err), "error");
			}
		},
	});

	pi.registerTool({
		name: "pi_sync",
		label: "Pi Config Sync",
		description:
			"Sync the user's Pi agent config (settings, extensions, skills, prompts, memory, extra paths) with their private git repo. " +
			"action=status shows repo state; push copies local config into the repo, commits and pushes; " +
			"pull fetches the repo and deploys it onto this machine (backs up replaced files).",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("status"), Type.Literal("push"), Type.Literal("pull")]),
			message: Type.Optional(Type.String({ description: "Commit subject for push" })),
			repo: Type.Optional(
				Type.String({
					description:
						"Git URL to use instead of the configured one (bootstraps a machine with no pi-sync.json)",
				}),
			),
		}),
		execute: async (_toolCallId, params) => {
			const action = params.action;
			const result =
				action === "push"
					? await push(pi, params.message)
					: action === "pull"
						? await pull(pi, params.repo)
						: await status(pi, params.repo);
			return {
				content: [{ type: "text", text: result.summary }],
				details: { action, ok: result.ok },
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const cfg = await readConfig().catch(() => undefined);
		if (!cfg?.autoPullOnStart) return;
		if (!(await exists(path.join(repoDir(cfg), ".git")))) return;
		try {
			const result = await pull(pi);
			if (ctx.hasUI) ctx.ui.notify(result.summary, "info");
		} catch (err) {
			if (ctx.hasUI) ctx.ui.notify(`pi-sync auto-pull failed: ${errorMessage(err)}`, "warning");
		}
	});

	pi.on("session_shutdown", async () => {
		const cfg = await readConfig().catch(() => undefined);
		if (!cfg?.autoPushOnExit) return;
		try {
			await push(pi, `auto-sync on exit (${os.hostname()})`);
		} catch {
			// Shutdown must not fail; the user can run /sync-push later.
		}
	});
}
