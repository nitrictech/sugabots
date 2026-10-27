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
		name: "review_pull_request",
		description:
			"Review a pull request: approve it, request changes, or comment, with comments on lines of its code.",
		readOnly: false,
		destructive: false,
	},
	{
		name: "reply_to_code_comment",
		description: "Reply in the thread of a comment on a pull request's code.",
		readOnly: false,
		destructive: false,
	},
	{
		name: "open_issue",
		description: "Open an issue.",
		readOnly: false,
		destructive: false,
	},
	{
		name: "update_issue",
		description:
			"Label, assign, close or reopen an issue, or label and assign a pull request. Change the title or description only of a bot's own.",
		readOnly: false,
		destructive: false,
	},
	{
		name: "comment_on_issue",
		description: "Comment on an issue.",
		readOnly: false,
		destructive: false,
	},
	{
		name: "react",
		description: "React with an emoji to an issue, a pull request, or a comment.",
		readOnly: false,
		destructive: false,
	},
	{
		name: "edit_comment",
		description: "Change the words of a bot's own comment.",
		readOnly: false,
		destructive: false,
	},
	{
		name: "delete_comment",
		description: "Delete a bot's own comment.",
		readOnly: false,
		destructive: true,
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
	{
		name: "get_job_log",
		description: "Read the end of a GitHub Actions job's log.",
		readOnly: true,
		destructive: false,
	},
	{
		name: "search_issues",
		description: "Search a repository's issues and pull requests.",
		readOnly: true,
		destructive: false,
	},
	{
		name: "list_labels",
		description: "List the labels a repository's issues and pull requests can have.",
		readOnly: true,
		destructive: false,
	},
];
