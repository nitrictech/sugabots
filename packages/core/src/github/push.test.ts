import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Sandbox } from "../sandboxes/sandbox.ts";
import { describeBranch, pushBranch } from "./push.ts";

/**
 * The push, end to end, with git on this machine standing in for both the
 * sandbox and GitHub: a bare repository is the remote, and a clone of it is
 * the thread's worktree.
 */
describe("pushing a thread's branch", () => {
	let root: string;
	let remote: string;
	let worktree: string;

	const sh = (cwd: string, command: string) =>
		execFileSync("bash", ["-c", command], { cwd, encoding: "utf8" });

	/** A sandbox whose commands run here, in the worktree. */
	const localSandbox = (): Sandbox.Handle => ({
		id: "local",
		exec: (command) =>
			Effect.sync(() => {
				try {
					const stdout = execFileSync("bash", ["-c", command], {
						cwd: worktree,
						encoding: "utf8",
						stdio: ["ignore", "pipe", "pipe"],
					});
					return {
						exitCode: 0,
						stdout: { text: stdout, droppedCharacters: 0 },
						stderr: { text: "", droppedCharacters: 0 },
					};
				} catch (failure) {
					const error = failure as { status: number; stdout?: string; stderr?: string };
					return {
						exitCode: error.status,
						stdout: { text: String(error.stdout ?? ""), droppedCharacters: 0 },
						stderr: { text: String(error.stderr ?? ""), droppedCharacters: 0 },
					};
				}
			}),
		readFile: (path) => Effect.sync(() => new Uint8Array(readFileSync(path))),
		writeFile: () => Effect.void,
		setAllowedHosts: () => Effect.void,
		setGitCredentials: () => Effect.void,
		disconnect: Effect.void,
	});

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "push-test-"));
		remote = join(root, "remote.git");
		worktree = join(root, "work");
		sh(root, `git init --quiet --bare --initial-branch=main ${remote}`);
		sh(root, `git clone --quiet ${remote} seed 2>/dev/null`);
		sh(
			join(root, "seed"),
			"git config user.email t@t && git config user.name T && echo a > README && git add . && git commit -qm first && git push -q origin HEAD:main",
		);
		sh(root, `git clone --quiet ${remote} work`);
		sh(
			worktree,
			"git config user.email agent@t && git config user.name Agent && git checkout -qb pod/p/t",
		);
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const request = () => ({
		sandbox: localSandbox(),
		worktree,
		branch: "pod/p/t",
		repository: "acme/app",
		defaultBranch: "main",
		credentials: { apiBaseUrl: "https://api.github.com", gitHost: "github.com", token: "t" },
		remoteUrl: remote,
		clonesDirectory: join(root, "clones"),
	});

	it("pushes the branch's commits, and says what they change", async () => {
		sh(worktree, "echo b >> README && git commit -qam 'Change the readme'");

		const pushed = await Effect.runPromise(pushBranch(request()));

		expect(pushed).toMatchObject({
			branch: "pod/p/t",
			commits: ["Change the readme"],
			files: ["README"],
			compareUrl: "https://github.com/acme/app/compare/main...pod/p/t",
		});
		expect(sh(root, `git --git-dir=${remote} log --format=%s pod/p/t -1`).trim()).toBe(
			"Change the readme",
		);
	});

	it("says there's nothing to push when the branch has no new commits", async () => {
		const refused = await Effect.runPromise(Effect.flip(pushBranch(request())));

		expect(refused.message).toMatch(/nothing to push/);
	});

	it("never overwrites commits on GitHub that the branch doesn't have", async () => {
		sh(worktree, "echo b >> README && git commit -qam one");
		await Effect.runPromise(pushBranch(request()));
		sh(worktree, "git reset -q --hard origin/main && echo c >> README && git commit -qam two");

		const refused = await Effect.runPromise(Effect.flip(pushBranch(request())));

		expect(refused.message).toMatch(/Nothing was overwritten/);
	});

	it("points out workflow changes before a push", async () => {
		sh(
			worktree,
			"mkdir -p .github/workflows && echo x > .github/workflows/ci.yml && git add . && git commit -qm ci",
		);

		const described = await Effect.runPromise(
			describeBranch(localSandbox(), worktree, "pod/p/t", "main"),
		);

		expect(described).toMatchObject({
			head: expect.stringMatching(/^[0-9a-f]{40}$/),
			commits: ["ci"],
			workflowChanges: [".github/workflows/ci.yml"],
		});
	});
});
