import { connectionToolKey } from "@sugabots/contracts";
import { asSchema, type Tool, tool } from "ai";
import { and, eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { type Database, query, type RunEffect } from "../../../database/database.ts";
import { agent, toolCall, user } from "../../../database/schema.ts";
import { GitHubConnections } from "../../../providers/connections/github/github-connections.ts";
import * as GitHubReads from "../../../providers/connections/github/github-reads.ts";
import { GITHUB_CONNECTION_TOOLS } from "../../../providers/connections/github/github-tools.ts";
import { BUNDLE_REF, pushBundle } from "../../../providers/connections/github/push.ts";
import { toolAccessOf } from "../../../providers/connections/tool-access.ts";
import { Sandboxes } from "../../../sandboxes/sandboxes.ts";
import type { OfferedTool } from "../connections.ts";
import { inSandbox, type OpenSandbox, type Place } from "../sandbox/tools.ts";

/** The largest bundle a push carries: a whole branch's history, read into the API's memory. */
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;

/** The pod's sandbox, while the turn may use it, for tools that work from a checkout there. */
export interface Workspace {
	readonly open: OpenSandbox;
	readonly place: Place;
}

/**
 * The tools of a pod's GitHub connection, offered like an MCP server's
 * through the turn's catalog, so the pod's choice for each, and its
 * approvals, apply the same way. Each works on the connection's repositories
 * alone, with a token for its account that the sandbox never sees.
 */
export function gitHubTools({
	connected,
	turnId,
	agentId,
	workspace,
	run,
}: {
	connected: GitHubConnections.Connected;
	turnId: string;
	agentId: string;
	/** Undefined when the turn has no sandbox, so pushes are refused. */
	workspace: Workspace | undefined;
	run: RunEffect<Database>;
}): Record<string, OfferedTool> {
	const { connection } = connected;
	const repositorySchema = Schema.String.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(255),
	).annotate({
		description: `One of the connection's repositories, as owner/name: ${connected.repositories.join(", ")}`,
	});

	/** Runs `work` on `repository` if it is one of the connection's, telling the bot why not otherwise. */
	const onRepository = async <A>(
		repository: string,
		work: (path: string) => Effect.Effect<A, unknown, Database>,
	): Promise<A | Failed> => {
		const path = connected.repository(repository);
		if (!path) return notConnectionRepository(repository, connected.repositories);
		return run(
			work(path).pipe(Effect.catch((failure) => Effect.succeed(failed(describeFailure(failure))))),
		) as Promise<A | Failed>;
	};

	const tools: Record<string, Tool> = {
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
		open_pull_request: tool({
			description:
				"Open a pull request for a branch you pushed with push_branch. Write the title and description for the repository's reviewers: what changed and why, and how you checked it.",
			inputSchema: Schema.Struct({
				repository: repositorySchema,
				branch: botBranchSchema,
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
			execute: async ({ repository, branch, base, title, body, draft = false }, { toolCallId }) =>
				onRepository(repository, (path) =>
					Effect.gen(function* () {
						const signature = yield* attribution(
							{ agentId, turnId, sdkToolCallId: toolCallId },
							"opened this pull request",
						);
						const opened = yield* connected.openPullRequest({
							repository: path,
							head: branch,
							base,
							title,
							body: `${body}\n\n---\n${signature}`,
							draft,
						});
						return { status: "opened", ...opened };
					}),
				),
		}),
		update_pull_request: tool({
			description: `Change a pull request a bot opened, from a branch under ${GitHubConnections.BOT_BRANCH_PREFIX}: its title, description, base branch, whether it's a draft, or whether it's open. Leave out what stays the same. To change its code, push to its branch with push_branch.`,
			inputSchema: Schema.Struct({
				repository: repositorySchema,
				number: pullRequestNumberSchema,
				title: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
				body: Schema.optional(Schema.String.check(Schema.isMaxLength(60_000))).annotate({
					description: "The whole new description, in Markdown, replacing the old one",
				}),
				base: Schema.optional(
					Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
				).annotate({ description: "The branch to merge into" }),
				draft: Schema.optional(Schema.Boolean).annotate({
					description: "false marks a draft ready for review; true makes it a draft again",
				}),
				state: Schema.optional(Schema.Literals(["open", "closed"])).annotate({
					description: "closed closes it without merging; open reopens it",
				}),
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async ({ repository, number, title, body, base, draft, state }, { toolCallId }) =>
				onRepository(repository, (path) =>
					Effect.gen(function* () {
						const signed =
							body === undefined
								? undefined
								: `${body}\n\n---\n${yield* attribution(
										{ agentId, turnId, sdkToolCallId: toolCallId },
										"wrote this description",
									)}`;
						const updated = yield* connected.updatePullRequest({
							repository: path,
							number,
							title,
							body: signed,
							base,
							state,
							draft,
						});
						return { status: "updated", ...updated };
					}).pipe(
						Effect.catchTag("NotBotPullRequest", (refused) =>
							Effect.succeed(
								failed(
									`#${number} is from ${refused.branch}, not a branch under ${GitHubConnections.BOT_BRANCH_PREFIX}, so bots can't change it. Comment on it with comment_on_pull_request instead.`,
								),
							),
						),
					),
				),
		}),
		comment_on_pull_request: tool({
			description:
				"Comment on a pull request, such as to answer its reviewers or say what you changed. For a comment on a line of its code, quote the file and line.",
			inputSchema: Schema.Struct({
				repository: repositorySchema,
				number: pullRequestNumberSchema,
				body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60_000)).annotate({
					description: "The comment, in Markdown",
				}),
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async ({ repository, number, body }, { toolCallId }) =>
				onRepository(repository, (path) =>
					Effect.gen(function* () {
						const signature = yield* attribution(
							{ agentId, turnId, sdkToolCallId: toolCallId },
							"wrote this comment",
						);
						const commented = yield* connected.commentOnPullRequest({
							repository: path,
							number,
							body: `${body}\n\n---\n${signature}`,
						});
						return { status: "commented", ...commented };
					}),
				),
		}),
		list_issues: tool({
			description: "List a repository's issues, newest first, without their comments.",
			inputSchema: listSchema(repositorySchema),
			execute: async ({ repository, state = "open" }) =>
				onRepository(repository, (path) =>
					connected.read((http, token) =>
						GitHubReads.listIssues(http, token, { repository: path, state }),
					),
				),
		}),
		get_issue: tool({
			description: "Read an issue: its description, labels and comments.",
			inputSchema: numberedSchema(repositorySchema, "The issue's number"),
			execute: async ({ repository, number }) =>
				onRepository(repository, (path) =>
					connected.read((http, token) =>
						GitHubReads.getIssue(http, token, { repository: path, number }),
					),
				),
		}),
		list_pull_requests: tool({
			description: "List a repository's pull requests, newest first.",
			inputSchema: listSchema(repositorySchema),
			execute: async ({ repository, state = "open" }) =>
				onRepository(repository, (path) =>
					connected.read((http, token) =>
						GitHubReads.listPullRequests(http, token, { repository: path, state }),
					),
				),
		}),
		get_pull_request: tool({
			description:
				"Read a pull request: its description, branches, reviews, comments, and comments on its code.",
			inputSchema: numberedSchema(repositorySchema, "The pull request's number"),
			execute: async ({ repository, number }) =>
				onRepository(repository, (path) =>
					connected.read((http, token) =>
						GitHubReads.getPullRequest(http, token, { repository: path, number }),
					),
				),
		}),
		list_check_runs: tool({
			description:
				"List the checks, such as CI jobs, run on a branch or commit, with what each concluded and its summary.",
			inputSchema: Schema.Struct({
				repository: repositorySchema,
				ref: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)).annotate({
					description: "A branch name or a commit's hash",
				}),
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async ({ repository, ref }) =>
				onRepository(repository, (path) =>
					connected.read((http, token) =>
						GitHubReads.listCheckRuns(http, token, { repository: path, ref }),
					),
				),
		}),
	};

	const offered: Record<string, OfferedTool> = {};
	for (const described of GITHUB_CONNECTION_TOOLS) {
		const found = tools[described.name];
		if (!found) continue;
		const inputSchema = asSchema(found.inputSchema).jsonSchema;
		if ("then" in inputSchema) throw new Error(`The ${described.name} tool's schema isn't ready`);
		offered[connectionToolKey(connection.handle, described.name)] = {
			tool: found,
			handle: connection.handle,
			description: typeof found.description === "string" ? found.description : "",
			inputSchema,
			mutating: described.readOnly !== true,
			access: toolAccessOf(connection.toolAccess, described),
			connectionId: connection.id,
			connectionRevision: connection.configurationRevision,
			remoteToolName: described.name,
		};
	}
	return offered;
}

/** What the model is told of the pod's GitHub connection with the turn. */
export function gitHubNote(connected: GitHubConnections.Connected, signedIn: boolean): string {
	const listed = connected.repositories
		.map((repository) => `${repository} (https://github.com/${repository}.git)`)
		.join(", ");
	const reading = signedIn
		? "In the sandbox, git clone and fetch of them are signed in to read, outside the sandbox, without a token. There is no gh; read issues, pull requests and checks with the connection's tools."
		: "The sandbox's provider can't sign its requests in, so only public ones can be cloned.";
	return `The pod's GitHub connection, ${connected.connection.handle}, works on: ${listed}. ${reading} Nothing in the sandbox can push: commit your work, then use ${connected.connection.handle}'s push_branch with the commit's hash and a branch under ${GitHubConnections.BOT_BRANCH_PREFIX}, then open_pull_request. Change a pull request you opened with update_pull_request, or push to its branch again; answer its reviewers with comment_on_pull_request.`;
}

interface Failed {
	readonly status: "failed";
	readonly error: string;
}

const failed = (error: string): Failed => ({ status: "failed", error });

function notConnectionRepository(repository: string, repositories: readonly string[]): Failed {
	return failed(
		repositories.length === 0
			? "The GitHub connection has no repositories. Someone who manages the pod's connections adds them in its settings."
			: `${repository} isn't one of the GitHub connection's repositories: ${repositories.join(", ")}.`,
	);
}

/** What the bot is told of a failure: GitHub's or git's own words where there are some. */
function describeFailure(failure: unknown): string {
	if (typeof failure === "object" && failure !== null && "reason" in failure) {
		const tag = "_tag" in failure ? String(failure._tag) : "Failed";
		return `${tag === "PushFailed" ? "git push" : "GitHub"}: ${String(failure.reason)}`;
	}
	return String(failure);
}

const commitSchema = Schema.String.check(
	Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, {
		message: "Give the commit's full hash, from git rev-parse HEAD",
	}),
).annotate({ description: "The full hash of the commit to push, from git rev-parse HEAD" });

const botBranchSchema = Schema.String.check(
	Schema.isMaxLength(200),
	Schema.isPattern(/^sugabots\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/, {
		message: `Name a branch under ${GitHubConnections.BOT_BRANCH_PREFIX}, such as ${GitHubConnections.BOT_BRANCH_PREFIX}fix-login`,
	}),
).annotate({
	description: `The branch, which must start with ${GitHubConnections.BOT_BRANCH_PREFIX}, such as ${GitHubConnections.BOT_BRANCH_PREFIX}fix-login`,
});

const pullRequestNumberSchema = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
	description: "The pull request's number",
});

const listSchema = (repository: Schema.Codec<string>) =>
	Schema.Struct({
		repository,
		state: Schema.optional(Schema.Literals(["open", "closed", "all"])).annotate({
			description: "Which to list; open if left out",
		}),
	}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1);

const numberedSchema = (repository: Schema.Codec<string>, description: string) =>
	Schema.Struct({
		repository,
		number: Schema.Int.check(Schema.isGreaterThan(0)).annotate({ description }),
	}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1);

/**
 * The line under what a bot wrote on GitHub, such as a pull request's
 * description: which bot `did` it, and who allowed it.
 */
const attribution = (
	call: { agentId: string; turnId: string; sdkToolCallId: string },
	did: string,
) =>
	Effect.gen(function* () {
		const [opener] = yield* query((db) =>
			db.select({ name: agent.name }).from(agent).where(eq(agent.id, call.agentId)),
		);
		const [decider] = yield* query((db) =>
			db
				.select({ name: user.name })
				.from(toolCall)
				.innerJoin(user, eq(user.id, toolCall.decidedById))
				.where(
					and(eq(toolCall.turnId, call.turnId), eq(toolCall.sdkToolCallId, call.sdkToolCallId)),
				)
				.limit(1),
		);
		const bot = opener ? `**${opener.name}**, a bot in Sugabots,` : "A bot in Sugabots";
		return decider ? `${bot} ${did}, which ${decider.name} allowed.` : `${bot} ${did}.`;
	});

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
