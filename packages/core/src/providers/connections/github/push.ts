import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DomainError, userText } from "@sugabots/errors";
import { Effect, ErrorReporter, Schema } from "effect";
import * as GitHub from "./github.ts";

/** The ref a sandbox's bundle carries the commit to push under. */
export const BUNDLE_REF = "refs/sugabots/push";

/**
 * Pushes `commit`, carried by `bundle` under {@link BUNDLE_REF}, to `branch`
 * at `remoteUrl`, signed in with `credential`. Git checks every object it reads
 * from the bundle against its hash, so what is pushed is exactly `commit`
 * and its history, whoever could change the bundle before it got here. The
 * credential goes to git in its environment, never its arguments, which other
 * processes can read.
 */
export const pushBundle = (input: {
	bundle: Uint8Array;
	commit: string;
	remoteUrl: string;
	credential: GitHub.GitCredential;
	branch: string;
	force: boolean;
}) =>
	Effect.acquireUseRelease(
		inScratch(() => mkdtemp(join(tmpdir(), "sugabots-push-"))),
		(directory) =>
			Effect.gen(function* () {
				const bundlePath = join(directory, "push.bundle");
				const repository = join(directory, "repository.git");
				yield* inScratch(() => writeFile(bundlePath, input.bundle));
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
					GIT_CONFIG_VALUE_0: `Authorization: ${GitHub.basicAuthorizationValue(input.credential)}`,
				});
			}),
		(directory) =>
			inScratch(() => rm(directory, { recursive: true, force: true })).pipe(Effect.ignore),
	);

/** How long a git command may take, the upload of a whole bundle included. */
const GIT_TIMEOUT_MILLISECONDS = 5 * 60 * 1000;
const MAX_GIT_OUTPUT_BYTES = 10 * 1024 * 1024;

function inScratch<A>(work: () => Promise<A>) {
	return Effect.tryPromise({
		try: work,
		catch: (cause) => new PushFailed({ reason: `Couldn't use a scratch folder: ${String(cause)}` }),
	});
}

function git(cwd: string, args: readonly string[], env: Record<string, string> = {}) {
	return Effect.callback<string, PushFailed>((resume) => {
		const child = execFile(
			"git",
			args,
			{
				cwd,
				timeout: GIT_TIMEOUT_MILLISECONDS,
				maxBuffer: MAX_GIT_OUTPUT_BYTES,
				// Nothing from the server's own git config, nor a prompt for a password.
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
				const missing = "code" in error && error.code === "ENOENT";
				resume(
					Effect.fail(
						new PushFailed({
							reason: missing
								? "git isn't installed where Sugabots runs"
								: stderr.trim().split("\n").at(-1) || error.message,
						}),
					),
				);
			},
		);
		return Effect.sync(() => child.kill());
	});
}

/** Git couldn't push. `reason` is git's last line, which names refs and the remote's refusal. */
export class PushFailed
	extends Schema.TaggedError<PushFailed>()("PushFailed", { reason: Schema.String })
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return `git push failed: ${this.reason}`;
	}
	get userMessage() {
		return userText`The push didn't go through.`;
	}
}
