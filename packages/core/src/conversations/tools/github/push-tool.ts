import { tool } from "ai";
import { Effect, Schema } from "effect";
import { GitHubConnections } from "../../../providers/connections/github/github-connections.ts";
import { BUNDLE_REF, pushBundle } from "../../../providers/connections/github/push.ts";
import { Sandboxes } from "../../../sandboxes/sandboxes.ts";
import { inSandbox, type OpenSandbox, type Place } from "../sandbox/tools.ts";
import {
	botBranchSchema,
	commitSchema,
	failed,
	notConnectionRepository,
	type ToolContext,
} from "./shared.ts";

/** The largest bundle a push carries: a whole branch's history, read into the API's memory. */
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;

/** The pod's sandbox, while the turn may use it, for tools that work from a checkout there. */
export interface Workspace {
	readonly open: OpenSandbox;
	readonly place: Place;
}

/** `push_branch`, refused when `workspace` is undefined because the turn has no sandbox. */
export function pushTool(
	{ connected, turnId, repositorySchema, onRepository }: ToolContext,
	workspace: Workspace | undefined,
) {
	return {
		push_branch: tool({
			description: `Push a commit from a git checkout in the sandbox to a branch of one of the connection's repositories. Commit your work first, and pass the commit's full hash. The branch must start with ${GitHubConnections.BOT_BRANCH_PREFIX}. The checkout must have its full history: if it is shallow, run git fetch --unshallow first. GitHub refuses changes to .github/workflows. Pushing to the branch of an open pull request updates it; for a new branch, call open_pull_request once it's pushed.`,
			inputSchema: Schema.Struct({
				repository: repositorySchema,
				branch: botBranchSchema,
				commit: commitSchema,
				directory: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)).annotate({
					description: workspace
						? `The checkout, relative to ${workspace.place.folder} unless it starts with /`
						: "The checkout in the sandbox",
				}),
				force: Schema.optional(Schema.Boolean).annotate({
					description:
						"Replace the branch even if it has commits this one doesn't, as after a rebase",
				}),
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async ({ repository, directory, commit, branch, force = false }) => {
				const path = connected.repository(repository);
				if (!path) return notConnectionRepository(repository, connected.repositories);
				if (!workspace) return failed("This bot has no sandbox to push from in this turn.");
				const bundled = await inSandbox(workspace.open, (sandbox) =>
					bundleCommit(sandbox, workspace.place, { turnId, directory, commit }),
				);
				if (!("bundle" in bundled)) return bundled;
				return onRepository(path, (target) =>
					Effect.gen(function* () {
						const credential = yield* connected.writeCredential(target);
						yield* pushBundle({
							bundle: bundled.bundle,
							commit,
							remoteUrl: `https://github.com/${target}.git`,
							credential,
							branch,
							force,
						});
						return {
							status: "pushed",
							repository: target,
							branch,
							commit,
							url: `https://github.com/${target}/tree/${branch}`,
						};
					}),
				);
			},
		}),
	};
}

/** What the bundling script exits with when the checkout is shallow, so the bundle would lack history. */
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
	// Named by the turn, which bots never see, since it is copied out
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
		return { bundle };
	});
}
