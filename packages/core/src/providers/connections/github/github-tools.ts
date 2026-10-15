import type { ConnectionTool } from "@sugabots/contracts";

/**
 * A GitHub connection's tools, which are Sugabots' own: every GitHub
 * connection has this version's, so people choose what bots may do with
 * each, and new ones reach connections made before them. Those that change
 * something wait for a person until someone chooses otherwise.
 */
export const GITHUB_CONNECTION_TOOLS: readonly ConnectionTool[] = [
	{
		name: "push_branch",
		description: "Push a commit from a checkout in the sandbox to a branch under sugabots/.",
		readOnly: false,
		destructive: false,
	},
	{
		name: "open_pull_request",
		description: "Open a pull request for a branch pushed with push_branch.",
		readOnly: false,
		destructive: false,
	},
	{
		name: "update_pull_request",
		description:
			"Change a bot's pull request: its title, description, base, draft, or whether it's open.",
		readOnly: false,
		destructive: false,
	},
	{
		name: "comment_on_pull_request",
		description: "Comment on a pull request.",
		readOnly: false,
		destructive: false,
	},
	{
		name: "list_issues",
		description: "List a repository's issues.",
		readOnly: true,
		destructive: false,
	},
	{
		name: "get_issue",
		description: "Read an issue and its comments.",
		readOnly: true,
		destructive: false,
	},
	{
		name: "list_pull_requests",
		description: "List a repository's pull requests.",
		readOnly: true,
		destructive: false,
	},
	{
		name: "get_pull_request",
		description: "Read a pull request with its reviews and comments.",
		readOnly: true,
		destructive: false,
	},
	{
		name: "list_check_runs",
		description: "List the checks run on a branch or commit, with what each concluded.",
		readOnly: true,
		destructive: false,
	},
];
