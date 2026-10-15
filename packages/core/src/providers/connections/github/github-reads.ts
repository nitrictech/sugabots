import { Effect, Schema } from "effect";
import type { EgressHttpClient } from "../../network/egress.ts";
import { call, decoded } from "./github.ts";

/**
 * What bots read of a repository's issues, pull requests and checks, as
 * GitHub's API gives them, kept to what a bot needs to work on them: no
 * avatars, node ids or API links.
 */

/** At most this many of a list are read at once. */
const LIST_SIZE = 30;

const User = Schema.NullOr(Schema.Struct({ login: Schema.String }));
const loginOf = (user: typeof User.Type) => user?.login ?? "ghost";

const Comment = Schema.Struct({
	user: User,
	body: Schema.NullOr(Schema.String),
	created_at: Schema.String,
});
const commentOf = (comment: typeof Comment.Type) => ({
	author: loginOf(comment.user),
	body: comment.body ?? "",
	at: comment.created_at,
});

const Issue = Schema.Struct({
	number: Schema.Int,
	title: Schema.String,
	state: Schema.String,
	user: User,
	body: Schema.NullOr(Schema.String),
	html_url: Schema.String,
	labels: Schema.Array(Schema.Struct({ name: Schema.String })),
	pull_request: Schema.optional(Schema.Unknown),
	created_at: Schema.String,
});

export const listIssues = (
	http: EgressHttpClient,
	token: string,
	{ repository, state }: { repository: string; state: "open" | "closed" | "all" },
) =>
	call(http, "GET", `/repos/${repository}/issues?state=${state}&per_page=${LIST_SIZE}`, {
		bearer: token,
	}).pipe(
		Effect.flatMap(decoded(Schema.Array(Issue))),
		// GitHub lists pull requests among issues; they have their own list.
		Effect.map((issues) =>
			issues
				.filter((issue) => issue.pull_request === undefined)
				.map((issue) => ({
					number: issue.number,
					title: issue.title,
					state: issue.state,
					author: loginOf(issue.user),
					labels: issue.labels.map((label) => label.name),
					url: issue.html_url,
				})),
		),
	);

export const getIssue = (
	http: EgressHttpClient,
	token: string,
	{ repository, number }: { repository: string; number: number },
) =>
	Effect.gen(function* () {
		const [issue, comments] = yield* Effect.all([
			call(http, "GET", `/repos/${repository}/issues/${number}`, { bearer: token }).pipe(
				Effect.flatMap(decoded(Issue)),
			),
			call(http, "GET", `/repos/${repository}/issues/${number}/comments?per_page=100`, {
				bearer: token,
			}).pipe(Effect.flatMap(decoded(Schema.Array(Comment)))),
		]);
		return {
			number: issue.number,
			title: issue.title,
			state: issue.state,
			author: loginOf(issue.user),
			body: issue.body ?? "",
			labels: issue.labels.map((label) => label.name),
			url: issue.html_url,
			comments: comments.map(commentOf),
		};
	});

const PullRequest = Schema.Struct({
	number: Schema.Int,
	title: Schema.String,
	state: Schema.String,
	draft: Schema.optional(Schema.Boolean),
	merged: Schema.optional(Schema.Boolean),
	user: User,
	body: Schema.NullOr(Schema.String),
	html_url: Schema.String,
	head: Schema.Struct({ ref: Schema.String, sha: Schema.String }),
	base: Schema.Struct({ ref: Schema.String }),
});

export const listPullRequests = (
	http: EgressHttpClient,
	token: string,
	{ repository, state }: { repository: string; state: "open" | "closed" | "all" },
) =>
	call(http, "GET", `/repos/${repository}/pulls?state=${state}&per_page=${LIST_SIZE}`, {
		bearer: token,
	}).pipe(
		Effect.flatMap(decoded(Schema.Array(PullRequest))),
		Effect.map((pulls) =>
			pulls.map((pull) => ({
				number: pull.number,
				title: pull.title,
				state: pull.state,
				draft: pull.draft ?? false,
				author: loginOf(pull.user),
				branch: pull.head.ref,
				base: pull.base.ref,
				url: pull.html_url,
			})),
		),
	);

const Review = Schema.Struct({
	user: User,
	state: Schema.String,
	body: Schema.NullOr(Schema.String),
	submitted_at: Schema.optional(Schema.NullOr(Schema.String)),
});

const ReviewComment = Schema.Struct({
	user: User,
	body: Schema.String,
	path: Schema.String,
	line: Schema.optional(Schema.NullOr(Schema.Int)),
	created_at: Schema.String,
});

export const getPullRequest = (
	http: EgressHttpClient,
	token: string,
	{ repository, number }: { repository: string; number: number },
) =>
	Effect.gen(function* () {
		const [pull, reviews, comments, codeComments] = yield* Effect.all([
			call(http, "GET", `/repos/${repository}/pulls/${number}`, { bearer: token }).pipe(
				Effect.flatMap(decoded(PullRequest)),
			),
			call(http, "GET", `/repos/${repository}/pulls/${number}/reviews?per_page=100`, {
				bearer: token,
			}).pipe(Effect.flatMap(decoded(Schema.Array(Review)))),
			call(http, "GET", `/repos/${repository}/issues/${number}/comments?per_page=100`, {
				bearer: token,
			}).pipe(Effect.flatMap(decoded(Schema.Array(Comment)))),
			call(http, "GET", `/repos/${repository}/pulls/${number}/comments?per_page=100`, {
				bearer: token,
			}).pipe(Effect.flatMap(decoded(Schema.Array(ReviewComment)))),
		]);
		return {
			number: pull.number,
			title: pull.title,
			state: pull.merged ? "merged" : pull.state,
			draft: pull.draft ?? false,
			author: loginOf(pull.user),
			body: pull.body ?? "",
			branch: pull.head.ref,
			headCommit: pull.head.sha,
			base: pull.base.ref,
			url: pull.html_url,
			reviews: reviews.map((review) => ({
				author: loginOf(review.user),
				verdict: review.state,
				body: review.body ?? "",
				at: review.submitted_at ?? null,
			})),
			comments: comments.map(commentOf),
			codeComments: codeComments.map((comment) => ({
				author: loginOf(comment.user),
				path: comment.path,
				line: comment.line ?? null,
				body: comment.body,
				at: comment.created_at,
			})),
		};
	});

const CheckRuns = Schema.Struct({
	check_runs: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			status: Schema.String,
			conclusion: Schema.NullOr(Schema.String),
			html_url: Schema.NullOr(Schema.String),
			output: Schema.Struct({
				title: Schema.NullOr(Schema.String),
				summary: Schema.NullOr(Schema.String),
			}),
		}),
	),
});

/** The checks run on `ref`, a branch or commit, with what each concluded. */
export const listCheckRuns = (
	http: EgressHttpClient,
	token: string,
	{ repository, ref }: { repository: string; ref: string },
) =>
	call(
		http,
		"GET",
		`/repos/${repository}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
		{ bearer: token },
	).pipe(
		Effect.flatMap(decoded(CheckRuns)),
		Effect.map(({ check_runs }) =>
			check_runs.map((run) => ({
				name: run.name,
				status: run.status,
				conclusion: run.conclusion,
				title: run.output.title,
				summary: run.output.summary,
				url: run.html_url,
			})),
		),
	);
