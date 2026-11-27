import { ApprovalRefused } from "@sugabots/contracts/errors/proofs";
import type { Tool } from "ai";
import { Effect } from "effect";
import type { Database, RunEffect } from "../../../database/database.ts";
import type { ResolvedTargets } from "../../../operations/operation.ts";
import {
	BOT_BRANCH_PREFIX,
	type Connected,
} from "../../../providers/connectors/github/connected.ts";
import {
	GITHUB_CONNECTOR_TOOLS,
	type GitHubToolName,
} from "../../../providers/connectors/github/github-tools.ts";
import type { ComputerAtPlace } from "../computer/tools.ts";
import { type OfferedTool, offeredTool } from "../connector-catalog.ts";
import { issueTools } from "./issue-tools.ts";
import { pullRequestTools } from "./pull-request-tools.ts";
import { pushTool } from "./push-tool.ts";
import { readTools } from "./read-tools.ts";
import { toolContext } from "./shared.ts";

/**
 * The tools of a project's GitHub app, offered like an MCP server's through
 * the catalog of each turn that can use the project's connectors, so the
 * speaking bot's choice for each, and its approvals, apply the same way. Each works on the connector's repositories
 * alone, with a token for its account that the computer never sees.
 */
export function gitHubTools({
	connected,
	turnId,
	botId,
	computer,
	run,
}: {
	connected: Connected;
	turnId: string;
	botId: string;
	/** Undefined when the turn has no computer, so pushes are refused. */
	computer: ComputerAtPlace | undefined;
	run: RunEffect<Database>;
}): Record<string, OfferedTool> {
	const { connector } = connected;
	const context = toolContext({ connected, turnId, botId, run });
	// Every tool the connector describes, so one described without being built doesn't compile.
	const tools: Record<GitHubToolName, Tool> = {
		...pushTool(context, computer),
		...pullRequestTools(context),
		...issueTools(context),
		...readTools(context),
	};
	const offering = {
		connectorId: connector.id,
		handle: connector.handle,
		toolAccess: connector.toolAccess,
		configurationRevision: connector.configurationRevision,
	};
	return Object.fromEntries(
		GITHUB_CONNECTOR_TOOLS.map((described) => {
			const [key, offered] = offeredTool(offering, described, tools[described.name]);
			offered.resolveApprovalTargets = (input) =>
				resolveGitHubTargets(connected, described.name, input);
			if (computer && described.name === "push_branch") offered.usesComputer = () => true;
			return [key, offered];
		}),
	);
}

function resolveGitHubTargets(
	connected: Connected,
	toolName: GitHubToolName,
	input: Readonly<Record<string, unknown>>,
): Effect.Effect<ResolvedTargets, ApprovalRefused> {
	return Effect.gen(function* () {
		const repository =
			typeof input.repository === "string" && connected.repository(input.repository);
		if (!repository) return yield* new ApprovalRefused();
		const targets: Record<string, string> = {
			gitHubRepositoryId: String(connected.repositoryId(repository)),
		};
		if (toolName === "open_pull_request" && input.base === undefined) {
			targets.gitHubBaseBranch = yield* connected.defaultBranch(repository);
		} else if (
			toolName === "review_pull_request" &&
			input.commit === undefined &&
			typeof input.number === "number"
		) {
			targets.gitHubReviewCommit = yield* connected.pullRequestCommit(repository, input.number);
		} else if (toolName === "reply_to_code_comment" && typeof input.commentId === "number") {
			const comment = yield* connected.firstReviewCommentId(repository, input.commentId);
			targets.gitHubReplyCommentId = String(comment);
		}
		return targets;
	}).pipe(Effect.mapError(() => new ApprovalRefused()));
}

/** What the model is told of the bot's GitHub connector with the turn. */
export function gitHubNote(connected: Connected, signedIn: boolean): string {
	const listed = connected.repositories
		.map((repository) => `${repository} (https://github.com/${repository}.git)`)
		.join(", ");
	const reading = signedIn
		? "In the computer, git clone and fetch of them are signed in to read, outside the computer, without a token. There is no gh; read issues, pull requests and checks with the connector's tools."
		: "The computer isn't signed in to them, so only public ones can be cloned.";
	return `Your GitHub connector, ${connected.connector.handle}, works on: ${listed}. ${reading} Nothing on your computer can push: commit your work, then use ${connected.connector.handle}'s push_branch with the commit's hash and a branch under ${BOT_BRANCH_PREFIX}, then open_pull_request. Stack a chain of pull requests, each based on the branch of the one below, with create_stack, and put more on top of a stack with add_to_stack. Change a pull request you opened with update_pull_request, or push to its branch again; answer its reviewers with comment_on_pull_request and reply_to_code_comment. Review others' with review_pull_request. Work on issues with comment_on_issue, open_issue and update_issue, and acknowledge what you were asked with react. When a check fails, read why with list_check_runs and get_job_log.`;
}
