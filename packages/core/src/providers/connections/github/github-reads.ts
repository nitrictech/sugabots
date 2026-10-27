import { Effect, Schema } from "effect";
import type { EgressHttpClient } from "../../network/egress.ts";
import { call, decoded, GitHubRequestFailed, getPage, redirectOf } from "./github.ts";

/**
 * What bots read of a repository's issues, pull requests and checks, as
 * GitHub's API gives them, kept to what a bot needs to work on them: no
 * avatars, node ids or API links.
 */

/** At most this many of a list are read at once. */
const LIST_SIZE = 30;
/** GitHub's largest page. */
const PAGE_SIZE = 100;
/** At most this many pages of an issue's or pull request's comments, or of a repository's labels, are read. */
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

/**
 * A list GitHub gives oldest first, such as an issue's comments: its first
 * page and its newest pages, up to {@link MAX_PAGES} in all, and whether
 * pages between them were left out.
 */
const firstAndNewestPages = <S extends Schema.Decoder<unknown>>(
	http: EgressHttpClient,
	token: string,
	path: string,
	schema: S,
) =>
	Effect.gen(function* () {
		const list = `${path}?per_page=${PAGE_SIZE}`;
		const page = (number: number) =>
			getPage(http, token, list, number).pipe(
				Effect.flatMap(({ body, lastPage }) =>
					Effect.map(decoded(Schema.Array(schema))(body), (items) => ({ items, lastPage })),
				),
			);
		const first = yield* page(1);
		const fromPage = Math.max(2, first.lastPage - MAX_PAGES + 2);
		const newest = yield* Effect.forEach(
			Array.from({ length: Math.max(0, first.lastPage - fromPage + 1) }, (_, at) => fromPage + at),
			page,
			{ concurrency: "unbounded" },
		);
		return {
			items: [...first.items, ...newest.flatMap((read) => read.items)],
			olderLeftOut: fromPage > 2,
		};
	});

export const getIssue = (
	http: EgressHttpClient,
	token: string,
	{ repository, number }: { repository: string; number: number },
) =>
	Effect.gen(function* () {
		const [issue, comments] = yield* Effect.all(
			[
				call(http, "GET", `/repos/${repository}/issues/${number}`, { bearer: token }).pipe(
					Effect.flatMap(decoded(Issue)),
				),
				firstAndNewestPages(http, token, `/repos/${repository}/issues/${number}/comments`, Comment),
			],
			{ concurrency: "unbounded" },
		);
		return {
			...aboutIssue(issue),
			body: issue.body ?? "",
			isPullRequest: issue.pull_request !== undefined,
			comments: comments.items.map(commentOf),
			...leftOut(comments, "comments"),
		};
	});

/** Says which of a read's lists had pages between their first and newest left out. */
const leftOut = (read: { olderLeftOut: boolean }, list: string) =>
	read.olderLeftOut
		? { note: `Some of the ${list} between the first and the newest were left out.` }
		: {};

const SearchResults = Schema.Struct({
	total_count: Schema.Int,
	items: Schema.Array(Issue),
});

/** The most results GitHub's search gives for a query, however many match. */
const MAX_SEARCH_RESULTS = 1_000;

/** A qualifier saying whether a search is for issues or pull requests, which GitHub requires one of. */
const SEARCH_KIND = /(?:^|\s)-?(?:is|type):(?:issue|pr|pull-request)\b/i;

/**
 * Issues or pull requests of `repository` that match `query`, in GitHub's
 * search syntax, kept to the repository; issues unless the query says.
 */
export const searchIssues = (
	http: EgressHttpClient,
	token: string,
	{ repository, query, page }: { repository: string; query: string; page: number },
) => {
	const kind = SEARCH_KIND.test(query) ? "" : " is:issue";
	const scoped = encodeURIComponent(`${query}${kind} repo:${repository}`);
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
			const reachable = Math.min(total_count, MAX_SEARCH_RESULTS);
			return paged(found, page, page * LIST_SIZE < reachable && items.length === LIST_SIZE);
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
	firstAndNewestPages(http, token, `/repos/${repository}/labels`, Label).pipe(
		Effect.map((labels) => ({
			labels: labels.items.map((label) => ({
				name: label.name,
				description: label.description ?? "",
			})),
			...leftOut(labels, "labels"),
		})),
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
		const [pull, reviews, comments, codeComments] = yield* Effect.all(
			[
				call(http, "GET", `/repos/${repository}/pulls/${number}`, { bearer: token }).pipe(
					Effect.flatMap(decoded(PullRequest)),
				),
				firstAndNewestPages(http, token, `/repos/${repository}/pulls/${number}/reviews`, Review),
				firstAndNewestPages(http, token, `/repos/${repository}/issues/${number}/comments`, Comment),
				firstAndNewestPages(
					http,
					token,
					`/repos/${repository}/pulls/${number}/comments`,
					ReviewComment,
				),
			],
			{ concurrency: "unbounded" },
		);
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
			reviews: reviews.items.map((review) => ({
				reviewId: review.id,
				author: loginOf(review.user),
				verdict: review.state,
				body: review.body ?? "",
				at: review.submitted_at ?? null,
			})),
			comments: comments.items.map(commentOf),
			codeComments: codeComments.items.map((comment) => ({
				commentId: comment.id,
				reviewId: comment.pull_request_review_id,
				inReplyTo: comment.in_reply_to_id ?? null,
				author: loginOf(comment.user),
				path: comment.path,
				line: comment.line ?? null,
				body: comment.body,
				at: comment.created_at,
			})),
			...leftOut(
				{
					olderLeftOut: reviews.olderLeftOut || comments.olderLeftOut || codeComments.olderLeftOut,
				},
				"reviews and comments",
			),
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
		const location = yield* redirectOf(
			http,
			token,
			`/repos/${repository}/actions/jobs/${jobId}/logs`,
		);
		// Kept with room for the timestamps taken off each line after.
		const tail = yield* Effect.tryPromise({
			try: async (signal) => {
				const response = await storage(location, { signal });
				if (!response.ok) throw new Error(`The log's storage answered ${response.status}`);
				return tailOf(response, 2 * MAX_LOG_CHARACTERS);
			},
			catch: (cause) =>
				new GitHubRequestFailed({
					status: undefined,
					reason: cause instanceof Error ? cause.message : String(cause),
				}),
		});
		const log = tail.text.replace(LOG_LINE_TIMESTAMP, "");
		const truncated = tail.truncated || log.length > MAX_LOG_CHARACTERS;
		return { truncated, log: truncated ? wholeLines(log.slice(-MAX_LOG_CHARACTERS)) : log };
	});

/**
 * The last `characters` of `response`'s body, read as it streams in so a
 * long log is never held whole, and whether there was more before them.
 */
async function tailOf(response: Response, characters: number) {
	const decoder = new TextDecoder();
	let text = "";
	let truncated = false;
	const reader = response.body?.getReader();
	for (let read = await reader?.read(); read && !read.done; read = await reader?.read()) {
		text += decoder.decode(read.value, { stream: true });
		if (text.length > characters) {
			text = text.slice(-characters);
			truncated = true;
		}
	}
	text += decoder.decode();
	return truncated ? { text: wholeLines(text), truncated } : { text, truncated };
}

/** `text` without the partial line a cut left at its start. */
const wholeLines = (text: string) => text.slice(text.indexOf("\n") + 1);
