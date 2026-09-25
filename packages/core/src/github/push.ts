import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Data, Effect } from "effect";
import type { Sandbox } from "../sandboxes/sandbox.ts";
import type { GithubCredentials } from "./client.ts";

const run = promisify(execFile);

/**
 * Pushing a thread's branch from its pod's sandbox to GitHub, without the
 * token ever entering the sandbox.
 *
 * The sandbox packs the branch's new commits into a git bundle; the server
 * fetches the bundle into a clone of its own, checks what it would push, and
 * pushes it with the workspace's token. The checks are what the sandbox can't
 * be trusted to make: that the branch is the thread's own, that it isn't the
 * default branch, and what it changes.
 */

export interface PushRequest {
	sandbox: Sandbox.Handle;
	/** The thread's worktree in the sandbox. */
	worktree: string;
	branch: string;
	repository: string;
	defaultBranch: string;
	credentials: GithubCredentials;
	/** The commit a person approved pushing. The push is refused if the branch is anywhere else. */
	head?: string;
	/** Where the server pushes to. Defaults to the repository on the credentials' git host. */
	remoteUrl?: string;
	/** Where the server keeps its clones. Defaults to one under the system's temporary directory. */
	clonesDirectory?: string;
}

export interface PushedBranch {
	branch: string;
	/** Commits on the branch that the default branch doesn't have. */
	commits: string[];
	/** Paths the branch changes relative to the default branch. */
	files: string[];
	compareUrl: string;
}

/** Why a push didn't happen, in words the agent can act on or pass on. */
export class PushRefused extends Data.TaggedError("PushRefused")<{ message: string }> {}

/** Where the server keeps its clones, one per repository, reused between pushes. */
const CLONES_DIRECTORY = join(tmpdir(), "sugabots-git");
const WORKFLOWS = /^\.github\/workflows\//;

export const pushBranch = (request: PushRequest): Effect.Effect<PushedBranch, PushRefused> =>
	Effect.tryPromise({
		try: () => push(request),
		catch: (cause) =>
			cause instanceof PushRefused
				? cause
				: new PushRefused({
						message: `The push failed: ${cause instanceof Error ? cause.message : String(cause)}`,
					}),
	});

/** What a push would change, for showing before anyone approves it. Nothing leaves the sandbox. */
export const describeBranch = (
	sandbox: Sandbox.Handle,
	worktree: string,
	branch: string,
	defaultBranch: string,
) =>
	sandbox
		.exec(
			[
				`cd ${quote(worktree)}`,
				`git rev-parse ${quote(branch)}`,
				"echo ---",
				`git log --format=%s ${quote(`origin/${defaultBranch}..${branch}`)}`,
				"echo ---",
				`git diff --name-only ${quote(`origin/${defaultBranch}...${branch}`)}`,
			].join(" && "),
			{ cwd: worktree, timeoutSeconds: 60, maxOutputCharacters: 20_000 },
		)
		.pipe(
			Effect.map((execution) => {
				const [head = "", commits = "", files = ""] = execution.stdout.text.split("---\n");
				return {
					head: head.trim(),
					commits: lines(commits),
					files: lines(files),
					workflowChanges: lines(files).filter((file) => WORKFLOWS.test(file)),
				};
			}),
		);

async function push(request: PushRequest): Promise<PushedBranch> {
	const bundlePath = `/tmp/sugabots-push-${crypto.randomUUID()}.bundle`;
	const bundled = await Effect.runPromise(
		request.sandbox.exec(
			[
				`cd ${quote(request.worktree)}`,
				`git bundle create --quiet ${quote(bundlePath)} ${quote(request.branch)} --not ${quote(`origin/${request.defaultBranch}`)}`,
			].join(" && "),
			{ cwd: request.worktree, timeoutSeconds: 120, maxOutputCharacters: 4_000 },
		),
	);
	if (bundled.exitCode !== 0) {
		const said = bundled.stderr.text.trim();
		throw new PushRefused({
			message: /empty bundle/i.test(said)
				? `There is nothing to push: ${request.branch} has no commits that ${request.defaultBranch} doesn't.`
				: `Packing the branch failed: ${said}`,
		});
	}
	const bundle = await Effect.runPromise(request.sandbox.readFile(bundlePath));

	const clone = await cloneFor(request);
	const scratch = await mkdtemp(join(tmpdir(), "sugabots-bundle-"));
	try {
		const file = join(scratch, "branch.bundle");
		await writeFile(file, bundle);
		const incoming = `refs/sugabots/incoming/${request.branch}`;
		await git(clone, ["bundle", "verify", "--quiet", file]);
		await git(clone, ["fetch", "--quiet", file, `+refs/heads/${request.branch}:${incoming}`]);
		if (request.head && (await git(clone, ["rev-parse", incoming])).trim() !== request.head) {
			throw new PushRefused({
				message: `${request.branch} has changed since the push was approved, so nothing was pushed. Ask for approval again.`,
			});
		}

		const base = `refs/remotes/origin/${request.defaultBranch}`;
		const commits = lines(await git(clone, ["log", "--format=%s", `${base}..${incoming}`]));
		const files = lines(await git(clone, ["diff", "--name-only", `${base}...${incoming}`]));
		await git(clone, ["push", "--quiet", "origin", `${incoming}:refs/heads/${request.branch}`], {
			credentials: request.credentials,
		}).catch((cause: unknown) => {
			const said = cause instanceof Error ? cause.message : String(cause);
			throw new PushRefused({
				message: /non-fast-forward|fetch first|rejected/i.test(said)
					? `GitHub refused the push because ${request.branch} there has commits this one doesn't. Nothing was overwritten.`
					: /403|denied|permission/i.test(said)
						? "GitHub refused the push: the workspace's token can't write to this repository."
						: `GitHub refused the push: ${said}`,
			});
		});
		return {
			branch: request.branch,
			commits,
			files,
			compareUrl: `https://${request.credentials.gitHost}/${request.repository}/compare/${request.defaultBranch}...${request.branch}`,
		};
	} finally {
		await rm(scratch, { recursive: true, force: true });
		await Effect.runPromise(
			request.sandbox.exec(`rm -f ${quote(bundlePath)}`, {
				cwd: request.worktree,
				timeoutSeconds: 10,
				maxOutputCharacters: 200,
			}),
		).catch(() => {});
	}
}

/** The server's clone of the repository, fetched up to date with the default branch. */
async function cloneFor(request: PushRequest): Promise<string> {
	const clone = join(
		request.clonesDirectory ?? CLONES_DIRECTORY,
		request.credentials.gitHost,
		`${request.repository}.git`,
	);
	const exists = await stat(clone).then(
		() => true,
		() => false,
	);
	if (!exists) {
		await mkdir(clone, { recursive: true });
		await git(clone, ["init", "--quiet", "--bare"]);
		await git(clone, [
			"remote",
			"add",
			"origin",
			request.remoteUrl ?? `https://${request.credentials.gitHost}/${request.repository}.git`,
		]);
	}
	await git(
		clone,
		[
			"fetch",
			"--quiet",
			"origin",
			`+refs/heads/${request.defaultBranch}:refs/remotes/origin/${request.defaultBranch}`,
		],
		{ credentials: request.credentials },
	);
	return clone;
}

/**
 * Runs git in `directory`. With credentials, they go in through git's
 * environment rather than its arguments, so they never show in a process list.
 */
async function git(
	directory: string,
	args: string[],
	options: { credentials?: GithubCredentials } = {},
): Promise<string> {
	const auth = options.credentials
		? {
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: "http.extraHeader",
				GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${options.credentials.token}`).toString("base64")}`,
			}
		: {};
	const { stdout } = await run("git", ["-C", directory, ...args], {
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...auth },
		maxBuffer: 16 * 1024 * 1024,
	});
	return stdout;
}

function lines(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function quote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
