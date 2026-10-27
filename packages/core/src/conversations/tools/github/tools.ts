import { connectionToolKey } from "@sugabots/contracts";
import { asSchema, type Tool, tool } from "ai";
import { and, eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { type Database, query, type RunEffect } from "../../../database/database.ts";
import { agent, toolCall, user } from "../../../database/schema.ts";
import * as GitHub from "../../../providers/connections/github/github.ts";
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
							body: signed(body, signature),
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
						const description =
							body === undefined
								? undefined
								: signed(
										body,
										yield* attribution(
											{ agentId, turnId, sdkToolCallId: toolCallId },
											"wrote this description",
										),
									);
						const updated = yield* connected.updatePullRequest({
							repository: path,
							number,
							title,
							body: description,
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
				"Comment in a pull request's conversation, such as to answer its reviewers or say what you changed. To comment on lines of its code, use review_pull_request; to answer a comment on its code, reply_to_code_comment.",
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
							body: signed(body, signature),
						});
						return { status: "commented", ...commented };
					}),
				),
		}),
		review_pull_request: tool({
			description:
				"Review a pull request: approve it, request changes, or just comment, with comments on lines of its code. Read it with get_pull_request and its code in a checkout first. GitHub refuses a review of the app's own pull requests other than a comment.",
			inputSchema: Schema.Struct({
				repository: repositorySchema,
				number: pullRequestNumberSchema,
				verdict: Schema.Literals(["approve", "request_changes", "comment"]),
				body: Schema.optional(Schema.String.check(Schema.isMaxLength(60_000))).annotate({
					description: "The review's summary, in Markdown",
				}),
				commit: Schema.optional(commitSchema).annotate({
					description:
						"The full hash of the commit you reviewed, so line comments land where you read them; its newest if left out",
				}),
				comments: Schema.optional(
					Schema.Array(
						Schema.Struct({
							path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)).annotate({
								description: "The file, relative to the repository's root",
							}),
							line: lineSchema.annotate({
								description: "The line commented on, or the last of the lines",
							}),
							startLine: Schema.optional(lineSchema).annotate({
								description: "The first of the lines, for a comment on several",
							}),
							side: Schema.optional(Schema.Literals(["head", "base"])).annotate({
								description:
									"head for lines the pull request adds or keeps, numbered as in its branch; base for lines it removes, numbered as before. head if left out",
							}),
							body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60_000)),
						}),
					).check(Schema.isMaxLength(MAX_REVIEW_COMMENTS)),
				).annotate({
					description: "Comments on lines the pull request's diff shows",
				}),
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async (
				{ repository, number, verdict, body = "", commit, comments = [] },
				{ toolCallId },
			) =>
				onRepository(repository, (path) =>
					Effect.gen(function* () {
						const signature = yield* attribution(
							{ agentId, turnId, sdkToolCallId: toolCallId },
							"wrote this review",
						);
						const reviewed = yield* connected.reviewPullRequest({
							repository: path,
							number,
							verdict,
							body: body ? signed(body, signature) : signature,
							commit,
							comments: comments.map((comment) => ({
								path: comment.path,
								line: comment.line,
								startLine: comment.startLine,
								side: comment.side ?? "head",
								body: comment.body,
							})),
						});
						return { status: "reviewed", ...reviewed };
					}),
				),
		}),
		reply_to_code_comment: tool({
			description:
				"Reply in the thread of a comment on a pull request's code, such as to say how you addressed it. Its commentId is in get_pull_request's codeComments.",
			inputSchema: Schema.Struct({
				repository: repositorySchema,
				number: pullRequestNumberSchema,
				commentId: commentIdSchema,
				body: commentBodySchema,
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async ({ repository, number, commentId, body }, { toolCallId }) =>
				onRepository(repository, (path) =>
					Effect.gen(function* () {
						const signature = yield* attribution(
							{ agentId, turnId, sdkToolCallId: toolCallId },
							"wrote this reply",
						);
						const replied = yield* connected.replyToCodeComment({
							repository: path,
							number,
							commentId,
							body: signed(body, signature),
						});
						return { status: "replied", ...replied };
					}),
				),
		}),
		open_issue: tool({
			description:
				"Open an issue, such as for a bug you found or work to follow up. Search for one already open with search_issues first.",
			inputSchema: Schema.Struct({
				repository: repositorySchema,
				title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
				body: Schema.String.check(Schema.isMaxLength(60_000)).annotate({
					description: "The issue's description, in Markdown",
				}),
				labels: Schema.optional(labelsSchema),
				assignees: Schema.optional(assigneesSchema),
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async ({ repository, title, body, labels, assignees }, { toolCallId }) =>
				onRepository(repository, (path) =>
					Effect.gen(function* () {
						const signature = yield* attribution(
							{ agentId, turnId, sdkToolCallId: toolCallId },
							"opened this issue",
						);
						const opened = yield* connected.openIssue({
							repository: path,
							title,
							body: signed(body, signature),
							labels,
							assignees,
						});
						return { status: "opened", ...opened };
					}),
				),
		}),
		update_issue: tool({
			description:
				"Change an issue: label, assign, close or reopen anyone's, and change the title or description only of one a bot opened. Label and assign a pull request too; change anything else of one with update_pull_request. Leave out what stays the same.",
			inputSchema: Schema.Struct({
				repository: repositorySchema,
				number: Schema.Int.check(Schema.isGreaterThan(0)).annotate({
					description: "The issue's or pull request's number",
				}),
				title: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
				body: Schema.optional(Schema.String.check(Schema.isMaxLength(60_000))).annotate({
					description: "The whole new description, in Markdown, replacing the old one",
				}),
				state: Schema.optional(Schema.Literals(["open", "closed"])),
				closedReason: Schema.optional(
					Schema.Literals(["completed", "not_planned", "duplicate"]),
				).annotate({ description: "Why it is closed, when closing it" }),
				labels: Schema.optional(labelsSchema).annotate({
					description:
						"Every label it should have, replacing those it has; list_labels lists the repository's",
				}),
				assignees: Schema.optional(assigneesSchema).annotate({
					description: "Everyone it should be assigned to, by login, replacing those it has",
				}),
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async (
				{ repository, number, title, body, state, closedReason, labels, assignees },
				{ toolCallId },
			) =>
				onRepository(repository, (path) =>
					Effect.gen(function* () {
						const description =
							body === undefined
								? undefined
								: signed(
										body,
										yield* attribution(
											{ agentId, turnId, sdkToolCallId: toolCallId },
											"wrote this description",
										),
									);
						const updated = yield* connected.updateIssue({
							repository: path,
							number,
							title,
							body: description,
							state,
							closedReason,
							labels,
							assignees,
						});
						return { status: "updated", ...updated };
					}).pipe(
						Effect.catchTags({
							NotBotIssue: (refused) =>
								Effect.succeed(
									failed(
										`#${number} was opened by ${refused.author}, not a bot, so bots can't change its title or description. Comment on it instead.`,
									),
								),
							IssueIsPullRequest: () =>
								Effect.succeed(
									failed(
										`#${number} is a pull request: change its title, description or state with update_pull_request. update_issue only labels and assigns it.`,
									),
								),
						}),
					),
				),
		}),
		comment_on_issue: tool({
			description: "Comment on an issue, such as to answer its author or say what you found.",
			inputSchema: Schema.Struct({
				repository: repositorySchema,
				number: Schema.Int.check(Schema.isGreaterThan(0)).annotate({
					description: "The issue's number",
				}),
				body: commentBodySchema,
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async ({ repository, number, body }, { toolCallId }) =>
				onRepository(repository, (path) =>
					Effect.gen(function* () {
						const signature = yield* attribution(
							{ agentId, turnId, sdkToolCallId: toolCallId },
							"wrote this comment",
						);
						const commented = yield* connected.commentOnIssue({
							repository: path,
							number,
							body: signed(body, signature),
						});
						return { status: "commented", ...commented };
					}),
				),
		}),
		react: tool({
			description:
				"React with an emoji to an issue, a pull request, or a comment, such as eyes to say you've seen it and are on it. Give number for an issue or pull request, commentId for a comment.",
			inputSchema: Schema.Struct({
				repository: repositorySchema,
				on: Schema.Literals(["issue", "pull_request", "comment", "code_comment"]).annotate({
					description:
						"What to react to: comment is one in an issue's or pull request's conversation, code_comment one on a pull request's code",
				}),
				number: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
					description: "The issue's or pull request's number",
				}),
				commentId: Schema.optional(commentIdSchema),
				reaction: Schema.Literals(GitHub.REACTIONS),
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async ({ repository, on, number, commentId, reaction }) => {
				const subject = reactionSubject(on, number, commentId);
				if ("status" in subject) return subject;
				return onRepository(repository, (path) =>
					Effect.as(connected.react({ repository: path, subject, reaction }), {
						status: "reacted",
					}),
				);
			},
		}),
		edit_comment: tool({
			description:
				"Replace the words of a comment a bot wrote, such as to correct it. Comments on code are code_comment; others are comment.",
			inputSchema: Schema.Struct({
				repository: repositorySchema,
				kind: commentKindSchema,
				commentId: commentIdSchema,
				body: commentBodySchema,
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async ({ repository, kind, commentId, body }, { toolCallId }) =>
				onRepository(repository, (path) =>
					Effect.gen(function* () {
						const signature = yield* attribution(
							{ agentId, turnId, sdkToolCallId: toolCallId },
							"wrote this comment",
						);
						const edited = yield* connected.editComment({
							repository: path,
							kind,
							commentId,
							body: signed(body, signature),
						});
						return { status: "edited", ...edited };
					}).pipe(Effect.catchTag("NotBotComment", notBotComment)),
				),
		}),
		delete_comment: tool({
			description: "Delete a comment a bot wrote.",
			inputSchema: Schema.Struct({
				repository: repositorySchema,
				kind: commentKindSchema,
				commentId: commentIdSchema,
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async ({ repository, kind, commentId }) =>
				onRepository(repository, (path) =>
					connected
						.deleteComment({ repository: path, kind, commentId })
						.pipe(
							Effect.as({ status: "deleted" }),
							Effect.catchTag("NotBotComment", notBotComment),
						),
				),
		}),
		list_issues: tool({
			description:
				"List a repository's issues, newest first, without their comments. To find some, use search_issues.",
			inputSchema: listSchema(repositorySchema),
			execute: async ({ repository, state = "open", page = 1 }) =>
				onRepository(repository, (path) =>
					connected.read((http, token) =>
						GitHubReads.listIssues(http, token, { repository: path, state, page }),
					),
				),
		}),
		search_issues: tool({
			description:
				"Search a repository's issues, or its pull requests with is:pr, in GitHub's search syntax, such as: is:open label:bug login error. Only the first 1,000 matches can be read.",
			inputSchema: Schema.Struct({
				repository: repositorySchema,
				query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
				page: pageSchema,
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async ({ repository, query, page = 1 }) =>
				onRepository(repository, (path) =>
					connected.read((http, token) =>
						GitHubReads.searchIssues(http, token, { repository: path, query, page }),
					),
				),
		}),
		list_labels: tool({
			description: "List the labels a repository's issues and pull requests can have.",
			inputSchema: Schema.Struct({ repository: repositorySchema }).pipe(
				Schema.toStandardSchemaV1,
				Schema.toStandardJSONSchemaV1,
			),
			execute: async ({ repository }) =>
				onRepository(repository, (path) =>
					connected.read((http, token) =>
						GitHubReads.listLabels(http, token, { repository: path }),
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
			execute: async ({ repository, state = "open", page = 1 }) =>
				onRepository(repository, (path) =>
					connected.read((http, token) =>
						GitHubReads.listPullRequests(http, token, { repository: path, state, page }),
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
		get_job_log: tool({
			description:
				"Read the end of a GitHub Actions job's log, where a failure is, such as to see why a check failed. Give a checkRunId from list_check_runs whose hasLog is true.",
			inputSchema: Schema.Struct({
				repository: repositorySchema,
				checkRunId: Schema.Int.check(Schema.isGreaterThan(0)),
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async ({ repository, checkRunId }) =>
				onRepository(repository, (path) =>
					connected.jobLog({ repository: path, jobId: checkRunId }),
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
	return `The pod's GitHub connection, ${connected.connection.handle}, works on: ${listed}. ${reading} Nothing in the sandbox can push: commit your work, then use ${connected.connection.handle}'s push_branch with the commit's hash and a branch under ${GitHubConnections.BOT_BRANCH_PREFIX}, then open_pull_request. Change a pull request you opened with update_pull_request, or push to its branch again; answer its reviewers with comment_on_pull_request and reply_to_code_comment. Review others' with review_pull_request. Work on issues with comment_on_issue, open_issue and update_issue, and acknowledge what you were asked with react. When a check fails, read why with list_check_runs and get_job_log.`;
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
	return failure instanceof Error ? failure.message : String(failure);
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

const pageSchema = Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
	description: "Which page to read, from 1; the last answer's nextPage",
});

const listSchema = (repository: Schema.Codec<string>) =>
	Schema.Struct({
		repository,
		state: Schema.optional(Schema.Literals(["open", "closed", "all"])).annotate({
			description: "Which to list; open if left out",
		}),
		page: pageSchema,
	}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1);

/** GitHub's most comments in one review. */
const MAX_REVIEW_COMMENTS = 100;

const lineSchema = Schema.Int.check(Schema.isGreaterThan(0));

const commentIdSchema = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
	description: "The comment's commentId, from get_issue, get_pull_request or the run's trigger",
});

const commentKindSchema = Schema.Literals(["comment", "code_comment"]).annotate({
	description:
		"code_comment for a comment on a pull request's code; comment for one in an issue's or pull request's conversation",
});

const commentBodySchema = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(60_000),
).annotate({ description: "The comment, in Markdown" });

const labelsSchema = Schema.Array(
	Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
).check(Schema.isMaxLength(100));

const assigneesSchema = Schema.Array(
	Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
).check(Schema.isMaxLength(10));

/** What `on` names, by `number` or `commentId`, or why it can't be reacted to. */
function reactionSubject(
	on: "issue" | "pull_request" | "comment" | "code_comment",
	number: number | undefined,
	commentId: number | undefined,
) {
	if (on === "issue" || on === "pull_request") {
		return number === undefined
			? failed(`Give the ${on === "issue" ? "issue's" : "pull request's"} number.`)
			: { kind: on, number };
	}
	return commentId === undefined
		? failed("Give the comment's commentId.")
		: { kind: on, commentId };
}

const notBotComment = (refused: GitHubConnections.NotBotComment) =>
	Effect.succeed(
		failed(`That comment is ${refused.author}'s, not a bot's, so bots can't change it.`),
	);

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

/** What divides what a bot wrote from its {@link attribution}. */
const SIGNATURE_DIVIDER = "\n\n---\n";

/** An {@link attribution} at the end of what a bot wrote, as bots read it back from GitHub. */
const TRAILING_SIGNATURE =
	/\n\n---\n(?:\*\*[^\n]*\*\*, a bot in Sugabots,|A bot in Sugabots) [^\n]*\s*$/;

/**
 * `body` with `signature` under it, in place of any signature it ends with,
 * since a bot changing what it wrote passes back what it read, signed.
 */
const signed = (body: string, signature: string) =>
	`${body.replace(TRAILING_SIGNATURE, "")}${SIGNATURE_DIVIDER}${signature}`;

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
