import { tool } from "ai";
import { Effect, Schema } from "effect";
import { GitHubConnections } from "../../../providers/connections/github/github-connections.ts";
import {
	botBranchSchema,
	commentBodySchema,
	commentIdSchema,
	commitSchema,
	failed,
	positiveIntegerSchema,
	pullRequestNumberSchema,
	type ToolContext,
} from "./shared.ts";

/** GitHub's most comments in one review. */
const MAX_REVIEW_COMMENTS = 100;

/** The tools that open, change, comment on and review pull requests. */
export function pullRequestTools({ connected, repositorySchema, onRepository, sign }: ToolContext) {
	return {
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
						const opened = yield* connected.openPullRequest({
							repository: path,
							head: branch,
							base,
							title,
							body: yield* sign(toolCallId, "opened this pull request", body),
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
						const updated = yield* connected.updatePullRequest({
							repository: path,
							number,
							title,
							body:
								body === undefined
									? undefined
									: yield* sign(toolCallId, "wrote this description", body),
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
				body: commentBodySchema,
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async ({ repository, number, body }, { toolCallId }) =>
				onRepository(repository, (path) =>
					Effect.gen(function* () {
						const commented = yield* connected.commentOnPullRequest({
							repository: path,
							number,
							body: yield* sign(toolCallId, "wrote this comment", body),
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
							line: positiveIntegerSchema.annotate({
								description: "The line commented on, or the last of the lines",
							}),
							startLine: Schema.optional(positiveIntegerSchema).annotate({
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
						const reviewed = yield* connected.reviewPullRequest({
							repository: path,
							number,
							verdict,
							body: yield* sign(toolCallId, "wrote this review", body),
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
						const replied = yield* connected.replyToCodeComment({
							repository: path,
							number,
							commentId,
							body: yield* sign(toolCallId, "wrote this reply", body),
						});
						return { status: "replied", ...replied };
					}),
				),
		}),
	};
}
