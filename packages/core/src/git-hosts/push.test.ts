import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUNDLE_REF, pushBundle } from "./push.ts";

/** Pushing a sandbox's bundle with real git, to a bare repository standing in for GitHub. */
describe("pushing a bundle", () => {
	let root: string;
	let remote: string;
	let checkout: string;

	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			env: {
				PATH: process.env.PATH,
				HOME: root,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_AUTHOR_NAME: "Agent",
				GIT_AUTHOR_EMAIL: "agent@example.com",
				GIT_COMMITTER_NAME: "Agent",
				GIT_COMMITTER_EMAIL: "agent@example.com",
			},
		}).trim();

	/** A commit in the checkout, and the bundle the sandbox would make of it. */
	const committed = (file: string) => {
		writeFileSync(join(checkout, file), file);
		git(checkout, "add", file);
		git(checkout, "commit", "--quiet", "-m", `Add ${file}`);
		const commit = git(checkout, "rev-parse", "HEAD");
		const bundlePath = join(root, `${commit}.bundle`);
		git(checkout, "update-ref", BUNDLE_REF, commit);
		git(checkout, "bundle", "create", "--quiet", bundlePath, BUNDLE_REF);
		return { commit, bundle: new Uint8Array(readFileSync(bundlePath)) };
	};

	const push = (input: { bundle: Uint8Array; commit: string; branch: string; force?: boolean }) =>
		Effect.runPromiseExit(
			pushBundle({ remoteUrl: remote, token: "unused", force: false, ...input }),
		);

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "sugabots-push-test-"));
		remote = join(root, "remote.git");
		checkout = join(root, "checkout");
		git(root, "init", "--quiet", "--bare", remote);
		git(root, "init", "--quiet", "--initial-branch=main", checkout);
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("pushes the commit and its history to the branch", async () => {
		committed("one");
		const { commit, bundle } = committed("two");

		const exit = await push({ bundle, commit, branch: "sugabots/work" });

		expect(Exit.isSuccess(exit)).toBe(true);
		expect(git(remote, "rev-parse", "refs/heads/sugabots/work")).toBe(commit);
		expect(git(remote, "log", "--format=%s", "sugabots/work")).toBe("Add two\nAdd one");
	});

	it("refuses a bundle that carries another commit than the one allowed", async () => {
		const allowed = committed("one");
		const other = committed("two");

		const exit = await push({
			bundle: other.bundle,
			commit: allowed.commit,
			branch: "sugabots/work",
		});

		expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
			reason: expect.stringContaining("not the commit that was allowed"),
		});
		expect(() =>
			git(remote, "rev-parse", "--verify", "--quiet", "refs/heads/sugabots/work"),
		).toThrow();
	});

	it("replaces a branch's other commits only when forced", async () => {
		const first = committed("one");
		await push({ ...first, branch: "sugabots/work" });
		git(checkout, "reset", "--quiet", "--hard", "HEAD");
		git(checkout, "checkout", "--quiet", "--orphan", "rewritten");
		const rewritten = committed("other");

		const refused = await push({ ...rewritten, branch: "sugabots/work" });
		const forced = await push({ ...rewritten, branch: "sugabots/work", force: true });

		expect(Exit.isFailure(refused)).toBe(true);
		expect(Exit.isSuccess(forced)).toBe(true);
		expect(git(remote, "rev-parse", "refs/heads/sugabots/work")).toBe(rewritten.commit);
	});
});
