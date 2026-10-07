import { repositoryNameSchema } from "@sugabots/contracts";
import { tool } from "ai";
import { Clock, DateTime, Effect, Schema } from "effect";
import type { RunEffect } from "../../../database/database.ts";
import type { GitHosts } from "../../../git-hosts/git-hosts.ts";
import { BUNDLE_REF } from "../../../git-hosts/push.ts";
import { Sandboxes } from "../../../sandboxes/sandboxes.ts";
import type { OpenSandbox, Place } from "../sandbox/tools.ts";
import type { Request } from "../sandbox.ts";

export const PUSH_BRANCH_TOOL = "push_branch";
export const OPEN_PULL_REQUEST_TOOL = "open_pull_request";

/** Agents push only to branches under this, so they can't move anyone else's. */
export const AGENT_BRANCH_PREFIX = "sugabots/";

/** The largest bundle a push carries: a whole branch's history, read into the API's memory. */
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;

const commitSchema = Schema.String.check(
	Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, {
		message: "Give the commit's full hash, from git rev-parse HEAD",
	}),
).annotate({ description: "The full hash of the commit to push, from git rev-parse HEAD" });

const agentBranchSchema = Schema.String.check(
	Schema.isMaxLength(200),
	Schema.isPattern(/^sugabots\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/, {
		message: `Name a branch under ${AGENT_BRANCH_PREFIX}, such as ${AGENT_BRANCH_PREFIX}fix-login`,
	}),
).annotate({
	description: `The branch, which must start with ${AGENT_BRANCH_PREFIX}, such as ${AGENT_BRANCH_PREFIX}fix-login`,
});

const repositorySchema = repositoryNameSchema.annotate({
	description: "One of the pod's repositories, as owner/name",
});

/**
 * The `push_branch` tool: an agent asking to push a commit from a checkout in
 * its sandbox to a branch of one of its pod's repositories. The call names
 * the commit by its hash, so what a person allows is exactly what is pushed:
 * once they have, the commit is bundled in the sandbox, brought to Sugabots,
 * and pushed from there with a token the sandbox never sees.
 */
export function pushBranch({
	turnId,
	place,
	gitHosts,
	openSandbox,
	run,
}: {
	turnId: string;
	place: Place;
	gitHosts: Pick<GitHosts.Interface, "allowedRequest" | "push">;
	openSandbox: OpenSandbox;
	run: RunEffect<never>;
}): Request {
	return {
		tool: tool({
			description: `Push a commit from a git checkout in the sandbox to a branch of one of the pod's repositories, which the turn's note lists. Commit your work first, and pass the commit's full hash. Someone in this pod decides, and your reply waits until they have. The branch must start with ${AGENT_BRANCH_PREFIX}. The checkout must have its full history: if it is shallow, run git fetch --unshallow first. GitHub refuses changes to .github/workflows. Once pushed, call ${OPEN_PULL_REQUEST_TOOL} to propose it.`,
			// In the order the approval card shows them: where it goes first.
			inputSchema: Schema.Struct({
				repository: repositorySchema,
				branch: agentBranchSchema,
				commit: commitSchema,
				directory: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)).annotate({
					description: `The checkout, relative to ${place.folder} unless it starts with /`,
				}),
				force: Schema.optional(Schema.Boolean).annotate({
					description:
						"Replace the branch even if it has commits this one doesn't, as after a rebase",
				}),
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async ({ repository, directory, commit, branch, force = false }, { toolCallId }) => {
				const request = await run(gitHosts.allowedRequest({ turnId, sdkToolCallId: toolCallId }));
				if (!request) return { status: "failed", error: "The push wasn't allowed." };
				const { sandbox } = await openSandbox();
				const bundled = await Effect.runPromise(
					bundleCommit(sandbox, place, { turnId, directory, commit }),
				);
				if (bundled.kind === "failed") return { status: "failed", error: bundled.error };
				return run(
					gitHosts
						.push(request, { repository, bundle: bundled.bundle, commit, branch, force })
						.pipe(
							Effect.map(({ url }) => ({ status: "pushed", repository, branch, commit, url })),
							Effect.catchTags({
								NotPodRepository: (failure) => Effect.succeed(notPodRepository(failure)),
								GitHubFailed: (failure) =>
									Effect.succeed({ status: "failed", error: `GitHub: ${failure.reason}` }),
								PushFailed: (failure) =>
									Effect.succeed({ status: "failed", error: `git push: ${failure.reason}` }),
							}),
						),
				);
			},
		}),
		refusal: () => undefined,
	};
}

/**
 * The `open_pull_request` tool: an agent asking to propose a branch it pushed
 * for merging. Someone in the pod decides; the pull request then says which
 * agent opened it and who allowed it.
 */
export function openPullRequest({
	turnId,
	agentId,
	gitHosts,
	run,
}: {
	turnId: string;
	agentId: string;
	gitHosts: Pick<GitHosts.Interface, "allowedRequest" | "openPullRequest">;
	run: RunEffect<never>;
}): Request {
	return {
		tool: tool({
			description: `Open a pull request for a branch you pushed with ${PUSH_BRANCH_TOOL}. Someone in this pod decides, and your reply waits until they have. Write the title and description for the repository's reviewers: what changed and why, and how you checked it.`,
			inputSchema: Schema.Struct({
				repository: repositorySchema,
				branch: agentBranchSchema,
				base: Schema.optional(
					Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
				).annotate({
					description: "The branch to merge into; the repository's default if left out",
				}),
				title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
				body: Schema.String.check(Schema.isMaxLength(60_000)).annotate({
					description: "The pull request's description, in Markdown",
				}),
				draft: Schema.optional(Schema.Boolean).annotate({
					description: "Open it as a draft, for work that isn't ready for review",
				}),
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async ({ repository, branch, base, title, body, draft = false }, { toolCallId }) => {
				const request = await run(gitHosts.allowedRequest({ turnId, sdkToolCallId: toolCallId }));
				if (!request) return { status: "failed", error: "The pull request wasn't allowed." };
				return run(
					gitHosts
						.openPullRequest(request, {
							repository,
							head: branch,
							base,
							title,
							body,
							draft,
							agentId,
						})
						.pipe(
							Effect.map(({ number, url }) => ({ status: "opened", number, url })),
							Effect.catchTags({
								NotPodRepository: (failure) => Effect.succeed(notPodRepository(failure)),
								GitHubFailed: (failure) =>
									Effect.succeed({ status: "failed", error: `GitHub: ${failure.reason}` }),
							}),
						),
				);
			},
		}),
		refusal: () => undefined,
	};
}

function notPodRepository(failure: GitHosts.NotPodRepository) {
	return {
		status: "failed",
		error:
			failure.repositories.length === 0
				? "This pod has no repositories. An admin of the pod adds them under Sandbox in its settings."
				: `${failure.repository} isn't one of this pod's repositories: ${failure.repositories.join(", ")}.`,
	};
}

/** What git exits with when the checkout is shallow, so the bundle would lack history. */
const SHALLOW_EXIT_CODE = 3;
const MISSING_COMMIT_EXIT_CODE = 4;
const TOO_LARGE_EXIT_CODE = 5;

/**
 * `commit` and its history as a bundle, made in the sandbox under
 * {@link BUNDLE_REF} and read out of it.
 */
function bundleCommit(
	sandbox: Sandboxes.Sandbox,
	place: Place,
	{ turnId, directory, commit }: { turnId: string; directory: string; commit: string },
) {
	// Named by the turn, which agents never see, since it is copied out
	// through the provider's file API (see `downloadFile`).
	const bundlePath = `/tmp/sugabots-push-${turnId}-${commit}.bundle`;
	const script = [
		"set -e",
		`[ "$(git rev-parse --is-shallow-repository)" = false ] || exit ${SHALLOW_EXIT_CODE}`,
		`git cat-file -e ${commit}^{commit} 2>/dev/null || exit ${MISSING_COMMIT_EXIT_CODE}`,
		`git update-ref ${BUNDLE_REF} ${commit}`,
		`git bundle create ${bundlePath} ${BUNDLE_REF} 2>/dev/null`,
		`git update-ref -d ${BUNDLE_REF}`,
		`[ "$(stat -c %s ${bundlePath})" -le ${MAX_BUNDLE_BYTES} ] || { rm -f ${bundlePath}; exit ${TOO_LARGE_EXIT_CODE}; }`,
	].join("\n");
	const cwd = directory.startsWith("/") ? directory : `${place.folder}/${directory}`;
	return Effect.gen(function* () {
		const made = yield* sandbox.exec(`bash -c ${Sandboxes.shellQuoted(script)}`, {
			cwd,
			env: { HOME: place.home },
			timeout: "5 minutes",
			maxOutputCharacters: 2_000,
		});
		switch (made.exitCode) {
			case 0:
				break;
			case SHALLOW_EXIT_CODE:
				return failed(
					`${directory} is a shallow clone. Run git fetch --unshallow there, then push again.`,
				);
			case MISSING_COMMIT_EXIT_CODE:
				return failed(`${directory} has no commit ${commit}.`);
			case TOO_LARGE_EXIT_CODE:
				return failed(`The branch's history is larger than ${MAX_BUNDLE_BYTES / 1024 / 1024} MB.`);
			default:
				return failed(
					`Couldn't bundle the commit in ${directory}: ${made.stderr.text.trim() || `exit ${made.exitCode ?? "timed out"}`}`,
				);
		}
		const bundle = yield* sandbox.downloadFile(bundlePath);
		yield* sandbox.exec(`rm -f ${bundlePath}`, { timeout: "30 seconds", maxOutputCharacters: 200 });
		return { kind: "bundled" as const, bundle };
	}).pipe(
		Effect.catchTags({
			SandboxUnavailable: (failure) => Effect.succeed(failed(failure.userMessage)),
			SandboxFileFailed: (failure) => Effect.succeed(failed(failure.reason)),
		}),
	);
}

const failed = (error: string) => ({ kind: "failed" as const, error });

/**
 * What the sandbox's commands sign in to the pod's repositories with: git
 * sends each account's token to that account's repositories on github.com,
 * and `gh` gets the token when there is one account. Each is read-only and
 * lasts an hour.
 */
export function gitEnvironment(access: readonly GitHosts.ReadAccess[]): Record<string, string> {
	if (access.length === 0) return {};
	const config = access.flatMap(({ account, token }, index) => [
		[`GIT_CONFIG_KEY_${index}`, `http.https://github.com/${account}/.extraHeader`],
		[
			`GIT_CONFIG_VALUE_${index}`,
			`Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
		],
	]);
	return Object.fromEntries([
		["GIT_CONFIG_COUNT", String(access.length)],
		...config,
		...(access.length === 1 && access[0] ? [["GH_TOKEN", access[0].token]] : []),
	]);
}

/** How long before a read token expires it is replaced, so a long command doesn't outlive it. */
const READ_TOKEN_MARGIN_MILLISECONDS = 10 * 60 * 1000;
/** How long a pod with no repositories goes before it is asked again. */
const NO_ACCESS_RECHECK_MILLISECONDS = 5 * 60 * 1000;

/**
 * The sandbox's sign-in to the pod's repositories, got by the first command
 * that needs it and again when it is near expiry.
 */
export function readAccessOncePerTurn(
	get: Effect.Effect<readonly GitHosts.ReadAccess[]>,
): Effect.Effect<Record<string, string>> {
	let held: { environment: Record<string, string>; until: number } | undefined;
	return Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis;
		if (held && held.until > now) return held.environment;
		const access = yield* get;
		const expiries = access.map((one) => DateTime.toEpochMillis(one.expiresAt));
		held = {
			environment: gitEnvironment(access),
			until:
				expiries.length === 0
					? now + NO_ACCESS_RECHECK_MILLISECONDS
					: Math.min(...expiries) - READ_TOKEN_MARGIN_MILLISECONDS,
		};
		return held.environment;
	});
}

/** What the agent is told of the pod's repositories with the turn, as they may change between turns. */
export function repositoriesNote(repositories: readonly string[]): string | undefined {
	if (repositories.length === 0) return undefined;
	return `The pod's repositories: ${repositories.join(", ")}. The sandbox's commands are signed in to read them, so git clone https://github.com/<owner>/<name> and gh's read commands work; nothing in the sandbox can push. To publish work, commit it, call ${PUSH_BRANCH_TOOL} with the commit's hash and a branch under ${AGENT_BRANCH_PREFIX}, then ${OPEN_PULL_REQUEST_TOOL}.`;
}
