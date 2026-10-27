import { and, eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { type Database, query, type RunEffect } from "../../../database/database.ts";
import { agent, toolCall, user } from "../../../database/schema.ts";
import {
	BOT_BRANCH_PREFIX,
	type Connected,
} from "../../../providers/connections/github/connected.ts";

/** What every tool of a pod's GitHub connection works with in a turn. */
export type ToolContext = ReturnType<typeof toolContext>;

export function toolContext({
	connected,
	turnId,
	agentId,
	run,
}: {
	connected: Connected;
	turnId: string;
	agentId: string;
	run: RunEffect<Database>;
}) {
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

	/**
	 * `body` with the {@link attribution} of tool call `toolCallId` under it,
	 * in place of one it already ends with, since a bot changing what it
	 * wrote passes back what it read, signed.
	 */
	const sign = (toolCallId: string, did: string, body: string) =>
		Effect.map(attribution({ agentId, turnId, sdkToolCallId: toolCallId }, did), (signature) => {
			const unsigned = body.replace(TRAILING_SIGNATURE, "");
			return unsigned ? `${unsigned}${SIGNATURE_DIVIDER}${signature}` : signature;
		});

	return { connected, turnId, repositorySchema, onRepository, sign };
}

export interface Failed {
	readonly status: "failed";
	readonly error: string;
}

export const failed = (error: string): Failed => ({ status: "failed", error });

export function notConnectionRepository(
	repository: string,
	repositories: readonly string[],
): Failed {
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

export const commitSchema = Schema.String.check(
	Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, {
		message: "Give the commit's full hash, from git rev-parse HEAD",
	}),
).annotate({ description: "The full hash of the commit to push, from git rev-parse HEAD" });

export const botBranchSchema = Schema.String.check(
	Schema.isMaxLength(200),
	Schema.isPattern(/^sugabots\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/, {
		message: `Name a branch under ${BOT_BRANCH_PREFIX}, such as ${BOT_BRANCH_PREFIX}fix-login`,
	}),
).annotate({
	description: `The branch, which must start with ${BOT_BRANCH_PREFIX}, such as ${BOT_BRANCH_PREFIX}fix-login`,
});

export const positiveIntegerSchema = Schema.Int.check(Schema.isGreaterThan(0));

export const issueNumberSchema = positiveIntegerSchema.annotate({
	description: "The issue's number",
});

export const issueOrPullRequestNumberSchema = positiveIntegerSchema.annotate({
	description: "The issue's or pull request's number",
});

export const pullRequestNumberSchema = positiveIntegerSchema.annotate({
	description: "The pull request's number",
});

export const commentIdSchema = positiveIntegerSchema.annotate({
	description: "The comment's commentId, from get_issue, get_pull_request or the run's trigger",
});

export const commentBodySchema = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(60_000),
).annotate({ description: "The comment, in Markdown" });

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
