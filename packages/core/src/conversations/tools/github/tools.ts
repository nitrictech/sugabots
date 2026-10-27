import { connectionToolKey } from "@sugabots/contracts";
import { asSchema, type Tool } from "ai";
import type { Database, RunEffect } from "../../../database/database.ts";
import { GitHubConnections } from "../../../providers/connections/github/github-connections.ts";
import { GITHUB_CONNECTION_TOOLS } from "../../../providers/connections/github/github-tools.ts";
import { toolAccessOf } from "../../../providers/connections/tool-access.ts";
import type { OfferedTool } from "../connections.ts";
import { issueTools } from "./issue-tools.ts";
import { pullRequestTools } from "./pull-request-tools.ts";
import { pushTool, type Workspace } from "./push-tool.ts";
import { readTools } from "./read-tools.ts";
import { toolContext } from "./shared.ts";

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
	const context = toolContext({ connected, turnId, agentId, run });
	const tools: Record<string, Tool> = {
		...pushTool(context, workspace),
		...pullRequestTools(context),
		...issueTools(context),
		...readTools(context),
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
