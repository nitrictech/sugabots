import { Effect, Schema } from "effect";
import type { EgressHttpClient } from "../../network/egress.ts";
import { API_URL, call, decoded, GitHubRequestFailed } from "./github.ts";

/**
 * What bots read of a repository's issues, pull requests and checks, as
 * GitHub's API gives them, kept to what a bot needs to work on them: no
 * avatars, node ids or API links.
 */

/** At most this many of a list are read at once. */
const LIST_SIZE = 30;
/** GitHub's largest page. */
const PAGE_SIZE = 100;
/** At most this many pages of a list read whole, such as an issue's comments, are read. */
const MAX_PAGES = 5;
/** The most of a job's log a bot is given: its end, where a failure is. */
const MAX_LOG_CHARACTERS = 30_000;

const User = Schema.NullOr(Schema.Struct({ login: Schema.String }));
const loginOf = (user: typeof User.Type) => user?.login ?? "ghost";

const Comment = Schema.Struct({
	id: Schema.Int,
	user: User,
	body: Schema.NullOr(Schema.String),
	created_at: Schema.String,
});
const commentOf = (comment: typeof Comment.Type) => ({
	commentId: comment.id,
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
	assignees: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ login: Schema.String })))),
	pull_request: Schema.optional(Schema.Unknown),
	created_at: Schema.String,
});

const aboutIssue = (issue: typeof Issue.Type) => ({
	number: issue.number,
	title: issue.title,
	state: issue.state,
	author: loginOf(issue.user),
	labels: issue.labels.map((label) => label.name),
	assignees: (issue.assignees ?? []).map((assignee) => assignee.login),
	url: issue.html_url,
});

/** A page of a list, and the next page's number while there may be more. */
const paged = <A>(items: readonly A[], page: number, fullPage: boolean) => ({
	items,
	nextPage: fullPage ? page + 1 : null,
});

export const listIssues = (
	http: EgressHttpClient,
	token: string,
	{
		repository,
		state,
		page,
	}: { repository: string; state: "open" | "closed" | "all"; page: number },
) =>
	call(
		http,
		"GET",
		`/repos/${repository}/issues?state=${state}&per_page=${LIST_SIZE}&page=${page}`,
		{ bearer: token },
	).pipe(
		Effect.flatMap(decoded(Schema.Array(Issue))),
		// GitHub lists pull requests among issues; they have their own list.
		Effect.map((issues) =>
			paged(
				issues.filter((issue) => issue.pull_request === undefined).map(aboutIssue),
				page,
				issues.length === LIST_SIZE,
			),
		),
	);

/** Every page of a list, up to {@link MAX_PAGES}. */
const allPages = <S extends Schema.Decoder<unknown>>(
	http: EgressHttpClient,
	token: string,
	path: string,
	schema: S,
) =>
	Effect.gen(function* () {
		const read: S["Type"][] = [];
		for (let page = 1; page <= MAX_PAGES; page++) {
			const found = yield* call(http, "GET", `${path}?per_page=${PAGE_SIZE}&page=${page}`, {
				bearer: token,
			}).pipe(Effect.flatMap(decoded(Schema.Array(schema))));
			read.push(...found);
			if (found.length < PAGE_SIZE) break;
		}
		return read;
	});

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
			allPages(http, token, `/repos/${repository}/issues/${number}/comments`, Comment),
		]);
		return {
			...aboutIssue(issue),
			body: issue.body ?? "",
			isPullRequest: issue.pull_request !== undefined,
			comments: comments.map(commentOf),
		};
	});

const SearchResults = Schema.Struct({
	total_count: Schema.Int,
	items: Schema.Array(Issue),
});

/**
 * Issues and pull requests of `repository` that match `query`, in GitHub's
 * search syntax, which is kept to the repository.
 */
export const searchIssues = (
	http: EgressHttpClient,
	token: string,
	{ repository, query, page }: { repository: string; query: string; page: number },
) => {
	const scoped = encodeURIComponent(`${query} repo:${repository}`);
	return call(http, "GET", `/search/issues?q=${scoped}&per_page=${LIST_SIZE}&page=${page}`, {
		bearer: token,
	}).pipe(
		Effect.flatMap(decoded(SearchResults)),
		Effect.map(({ items, total_count }) => {
			// A query's own repo: qualifiers would widen it; only the repository's are given.
			const prefix = `https://github.com/${repository}/`.toLowerCase();
			const found = items
				.filter((item) => item.html_url.toLowerCase().startsWith(prefix))
				.map((item) => ({ ...aboutIssue(item), isPullRequest: item.pull_request !== undefined }));
			return paged(found, page, page * LIST_SIZE < total_count && items.length === LIST_SIZE);
		}),
	);
};

const Label = Schema.Struct({ name: Schema.String, description: Schema.NullOr(Schema.String) });

/** The labels issues and pull requests can have in `repository`. */
export const listLabels = (
	http: EgressHttpClient,
	token: string,
	{ repository }: { repository: string },
) =>
	allPages(http, token, `/repos/${repository}/labels`, Label).pipe(
		Effect.map((labels) =>
			labels.map((label) => ({ name: label.name, description: label.description ?? "" })),
		),
	);

const PullRequest = Schema.Struct({
	number: Schema.Int,
	title: Schema.String,
	state: Schema.String,
	draft: Schema.optional(Schema.Boolean),
	merged: Schema.optional(Schema.Boolean),
	user: User,
	body: Schema.NullOr(Schema.String),
	html_url: Schema.String,
	labels: Schema.Array(Schema.Struct({ name: Schema.String })),
	head: Schema.Struct({ ref: Schema.String, sha: Schema.String }),
	base: Schema.Struct({ ref: Schema.String }),
});

export const listPullRequests = (
	http: EgressHttpClient,
	token: string,
	{
		repository,
		state,
		page,
	}: { repository: string; state: "open" | "closed" | "all"; page: number },
) =>
	call(
		http,
		"GET",
		`/repos/${repository}/pulls?state=${state}&per_page=${LIST_SIZE}&page=${page}`,
		{ bearer: token },
	).pipe(
		Effect.flatMap(decoded(Schema.Array(PullRequest))),
		Effect.map((pulls) =>
			paged(
				pulls.map((pull) => ({
					number: pull.number,
					title: pull.title,
					state: pull.state,
					draft: pull.draft ?? false,
					author: loginOf(pull.user),
					labels: pull.labels.map((label) => label.name),
					branch: pull.head.ref,
					base: pull.base.ref,
					url: pull.html_url,
				})),
				page,
				pulls.length === LIST_SIZE,
			),
		),
	);

const Review = Schema.Struct({
	id: Schema.Int,
	user: User,
	state: Schema.String,
	body: Schema.NullOr(Schema.String),
	submitted_at: Schema.optional(Schema.NullOr(Schema.String)),
});

const ReviewComment = Schema.Struct({
	id: Schema.Int,
	pull_request_review_id: Schema.NullOr(Schema.Int),
	in_reply_to_id: Schema.optional(Schema.Int),
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
			allPages(http, token, `/repos/${repository}/pulls/${number}/reviews`, Review),
			allPages(http, token, `/repos/${repository}/issues/${number}/comments`, Comment),
			allPages(http, token, `/repos/${repository}/pulls/${number}/comments`, ReviewComment),
		]);
		return {
			number: pull.number,
			title: pull.title,
			state: pull.merged ? "merged" : pull.state,
			draft: pull.draft ?? false,
			author: loginOf(pull.user),
			body: pull.body ?? "",
			labels: pull.labels.map((label) => label.name),
			branch: pull.head.ref,
			headCommit: pull.head.sha,
			base: pull.base.ref,
			url: pull.html_url,
			reviews: reviews.map((review) => ({
				reviewId: review.id,
				author: loginOf(review.user),
				verdict: review.state,
				body: review.body ?? "",
				at: review.submitted_at ?? null,
			})),
			comments: comments.map(commentOf),
			codeComments: codeComments.map((comment) => ({
				commentId: comment.id,
				reviewId: comment.pull_request_review_id,
				inReplyTo: comment.in_reply_to_id ?? null,
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
			id: Schema.Int,
			name: Schema.String,
			status: Schema.String,
			conclusion: Schema.NullOr(Schema.String),
			html_url: Schema.NullOr(Schema.String),
			app: Schema.NullOr(Schema.Struct({ slug: Schema.String })),
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
		`/repos/${repository}/commits/${encodeURIComponent(ref)}/check-runs?per_page=${PAGE_SIZE}`,
		{ bearer: token },
	).pipe(
		Effect.flatMap(decoded(CheckRuns)),
		Effect.map(({ check_runs }) =>
			check_runs.map((run) => ({
				checkRunId: run.id,
				name: run.name,
				status: run.status,
				conclusion: run.conclusion,
				hasLog: run.app?.slug === GITHUB_ACTIONS_APP,
				title: run.output.title,
				summary: run.output.summary,
				url: run.html_url,
			})),
		),
	);

/** The app GitHub Actions runs checks as. */
const GITHUB_ACTIONS_APP = "github-actions";

/** The timestamp GitHub starts each line of a job's log with. */
const LOG_LINE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z /gm;

/**
 * The end of GitHub Actions job `jobId`'s log, which is its check run's id.
 * GitHub answers with a redirect to a signed address at its storage,
 * fetched with `storage` and without the token.
 */
export const jobLog = (
	http: EgressHttpClient,
	storage: EgressHttpClient,
	token: string,
	{ repository, jobId }: { repository: string; jobId: number },
) =>
	Effect.gen(function* () {
		const redirect = yield* Effect.tryPromise({
			try: (signal) =>
				http(`${API_URL}/repos/${repository}/actions/jobs/${jobId}/logs`, {
					signal,
					headers: {
						accept: "application/vnd.github+json",
						"x-github-api-version": "2022-11-28",
						authorization: `Bearer ${token}`,
					},
				}),
			catch: (cause) => new GitHubRequestFailed({ status: undefined, reason: String(cause) }),
		});
		const location = redirect.headers.get("location");
		if (!location) {
			const reason = redirect.status === 404 ? "No such GitHub Actions job" : redirect.statusText;
			return yield* new GitHubRequestFailed({ status: redirect.status, reason });
		}
		const text = yield* Effect.tryPromise({
			try: async (signal) => {
				const response = await storage(location, { signal });
				if (!response.ok) throw new Error(`The log's storage answered ${response.status}`);
				return response.text();
			},
			catch: (cause) =>
				new GitHubRequestFailed({
					status: undefined,
					reason: cause instanceof Error ? cause.message : String(cause),
				}),
		});
		const log = text.replace(LOG_LINE_TIMESTAMP, "");
		return {
			truncated: log.length > MAX_LOG_CHARACTERS,
			log: log.slice(-MAX_LOG_CHARACTERS),
		};
	});
