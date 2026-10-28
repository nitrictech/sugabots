import { tool } from "ai";
import { Schema } from "effect";
import * as GitHubReads from "../../../providers/connections/github/github-reads.ts";
import {
	issueNumberSchema,
	positiveIntegerSchema,
	pullRequestNumberSchema,
	type ToolContext,
} from "./shared.ts";

/** The tools that read issues, pull requests, labels and checks, which change nothing. */
export function readTools({ connected, repositorySchema, onRepository }: ToolContext) {
	return {
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
			inputSchema: numberedSchema(repositorySchema, issueNumberSchema),
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
			inputSchema: numberedSchema(repositorySchema, pullRequestNumberSchema),
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
				checkRunId: positiveIntegerSchema,
			}).pipe(Schema.toStandardSchemaV1, Schema.toStandardJSONSchemaV1),
			execute: async ({ repository, checkRunId }) =>
				onRepository(repository, (path) =>
					connected.jobLog({ repository: path, jobId: checkRunId }),
				),
		}),
	};
}

const pageSchema = Schema.optional(positiveIntegerSchema).annotate({
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

const numberedSchema = (repository: Schema.Codec<string>, number: Schema.Codec<number>) =>
	Schema.Struct({ repository, number }).pipe(
		Schema.toStandardSchemaV1,
		Schema.toStandardJSONSchemaV1,
	);
