import { tool } from "ai";
import { Effect, Schema } from "effect";
import type { NotBotComment } from "../../../providers/connections/github/connected.ts";
import * as GitHub from "../../../providers/connections/github/github.ts";
import {
	commentBodySchema,
	commentIdSchema,
	failed,
	issueNumberSchema,
	issueOrPullRequestNumberSchema,
	type ToolContext,
} from "./shared.ts";

/**
 * The tools that open, change and comment on issues, and that react to,
 * edit and delete what's written on issues and pull requests.
 */
export function issueTools({ connected, repositorySchema, onRepository, sign }: ToolContext) {
	return {
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
						const opened = yield* connected.openIssue({
							repository: path,
							title,
							body: yield* sign(toolCallId, "opened this issue", body),
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
				number: issueOrPullRequestNumberSchema,
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
						const updated = yield* connected.updateIssue({
							repository: path,
							number,
							title,
							body:
								body === undefined
									? undefined
									: yield* sign(toolCallId, "wrote this description", body),
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
				number: issueNumberSchema,
				body: commentBodySchema,
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async ({ repository, number, body }, { toolCallId }) =>
				onRepository(repository, (path) =>
					Effect.gen(function* () {
						const commented = yield* connected.commentOnIssue({
							repository: path,
							number,
							body: yield* sign(toolCallId, "wrote this comment", body),
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
				number: Schema.optional(issueOrPullRequestNumberSchema),
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
						const edited = yield* connected.editComment({
							repository: path,
							kind,
							commentId,
							body: yield* sign(toolCallId, "wrote this comment", body),
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
	};
}

const commentKindSchema = Schema.Literals(["comment", "code_comment"]).annotate({
	description:
		"code_comment for a comment on a pull request's code; comment for one in an issue's or pull request's conversation",
});

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

const notBotComment = (refused: NotBotComment) =>
	Effect.succeed(
		failed(`That comment is ${refused.author}'s, not a bot's, so bots can't change it.`),
	);
