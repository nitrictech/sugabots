import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Data, Effect } from "effect";

/** The ref a sandbox's bundle carries the commit to push under. */
export const BUNDLE_REF = "refs/sugabots/push";

/**
 * Pushes `commit`, carried by `bundle` under {@link BUNDLE_REF}, to `branch`
 * at `remoteUrl`, signed in with `token`. Git checks every object it reads
 * from the bundle against its hash, so what is pushed is exactly `commit`
 * and its history, whoever could change the bundle before it got here. The
 * token goes to git in its environment, never its arguments, which other
 * processes can read.
 */
export const pushBundle = (input: {
	bundle: Uint8Array;
	commit: string;
	remoteUrl: string;
	token: string;
	branch: string;
	force: boolean;
}) =>
	Effect.acquireUseRelease(
		Effect.promise(() => mkdtemp(join(tmpdir(), "sugabots-push-"))),
		(directory) =>
			Effect.gen(function* () {
				const bundlePath = join(directory, "push.bundle");
				const repository = join(directory, "repository.git");
				yield* Effect.promise(() => writeFile(bundlePath, input.bundle));
				yield* git(directory, ["init", "--quiet", "--bare", repository]);
				yield* git(repository, ["fetch", "--quiet", bundlePath, `${BUNDLE_REF}:${BUNDLE_REF}`]);
				const fetched = (yield* git(repository, ["rev-parse", BUNDLE_REF])).trim();
				if (fetched !== input.commit) {
					return yield* new PushFailed({
						reason: `The bundle carries ${fetched}, not the commit that was allowed`,
					});
				}
				const refspec = `${input.force ? "+" : ""}${input.commit}:refs/heads/${input.branch}`;
				yield* git(repository, ["push", "--quiet", input.remoteUrl, refspec], {
					GIT_CONFIG_COUNT: "1",
					GIT_CONFIG_KEY_0: "http.extraHeader",
					GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${input.token}`).toString("base64")}`,
				});
			}),
		(directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
	);

/** How long a push may take, the upload of a whole bundle included. */
const GIT_TIMEOUT_MILLISECONDS = 5 * 60 * 1000;

function git(cwd: string, args: readonly string[], env: Record<string, string> = {}) {
	return Effect.callback<string, PushFailed>((resume) => {
		const child = execFile(
			"git",
			args,
			{
				cwd,
				timeout: GIT_TIMEOUT_MILLISECONDS,
				maxBuffer: 10 * 1024 * 1024,
				// Nothing from the server's own git config or a terminal prompt.
				env: {
					PATH: process.env.PATH,
					HOME: cwd,
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_TERMINAL_PROMPT: "0",
					...env,
				},
			},
			(error, stdout, stderr) => {
				if (!error) return resume(Effect.succeed(stdout));
				resume(
					Effect.fail(
						new PushFailed({
							reason:
								stderr.trim().split("\n").at(-1) ||
								("code" in error && error.code === "ENOENT"
									? "git isn't installed where Sugabots runs"
									: error.message),
						}),
					),
				);
			},
		);
		return Effect.sync(() => child.kill());
	});
}

/** Git couldn't push. `reason` is git's last line, which names refs and the remote's refusal. */
export class PushFailed extends Data.TaggedError("PushFailed")<{ reason: string }> {}
