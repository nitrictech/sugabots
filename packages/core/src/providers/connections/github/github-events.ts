import type { RepositoryEvent, RoutineExecutionTrigger } from "@sugabots/contracts";
import { Option, Schema } from "effect";
import * as GitHub from "./github.ts";

/** Something that happened at one of a GitHub account's repositories, as a routine's run is told of it. */
export type RepositoryActivity = Omit<
	Extract<RoutineExecutionTrigger, { kind: "github" }>,
	"kind" | "connectionId" | "receivedAt" | "deliveryId"
>;

/** The most of a comment or description a run is given. */
const MAX_TEXT_CHARACTERS = 4_000;
/** The most commits of a push a run is told of. */
const MAX_PUSHED_COMMITS = 20;

/**
 * What GitHub's delivery of `event` with `payload` says happened, or
 * `undefined` for one no routine is run by. Events the app caused itself,
 * such as a bot's push, are left out, so a routine can't run itself in a loop.
 */
export function activityOf(
	event: string | undefined,
	payload: unknown,
	appSlug: string,
): RepositoryActivity | undefined {
	const common = Schema.decodeUnknownOption(Common)(payload);
	if (Option.isNone(common)) return undefined;
	const { repository, sender } = common.value;
	if (sender.login === `${appSlug}[bot]`) return undefined;
	const found = (
		kind: RepositoryEvent,
		details: Omit<RepositoryActivity, "event" | "repository" | "sender">,
	): RepositoryActivity => ({
		event: kind,
		repository: repository.full_name,
		sender: sender.login,
		comment: null,
		...details,
		text: details.text === null ? null : details.text.slice(0, MAX_TEXT_CHARACTERS),
	});
	switch (event) {
		case "pull_request":
			return Option.match(Schema.decodeUnknownOption(PullRequestEvent)(payload), {
				onNone: () => undefined,
				onSome: ({ action, pull_request }) =>
					OPENED_ACTIONS.includes(action)
						? found("pull_request_opened", {
								...aboutPullRequest(pull_request),
								url: pull_request.html_url,
								text: pull_request.body ?? null,
							})
						: undefined,
			});
		case "pull_request_review":
			return Option.match(Schema.decodeUnknownOption(ReviewEvent)(payload), {
				onNone: () => undefined,
				onSome: ({ action, review, pull_request }) =>
					action === "submitted"
						? found("pull_request_review", {
								...aboutPullRequest(pull_request),
								url: review.html_url,
								text: `${REVIEW_STATES[review.state] ?? review.state}${review.body ? `\n\n${review.body}` : ""}`,
							})
						: undefined,
			});
		case "pull_request_review_comment":
			return Option.match(Schema.decodeUnknownOption(ReviewCommentEvent)(payload), {
				onNone: () => undefined,
				onSome: ({ action, comment, pull_request }) =>
					action === "created"
						? found("pull_request_comment", {
								...aboutPullRequest(pull_request),
								url: comment.html_url,
								text: `On ${comment.path}:\n\n${comment.body}`,
								comment: { id: comment.id, kind: "code_comment" },
							})
						: undefined,
			});
		case "issue_comment":
			return Option.match(Schema.decodeUnknownOption(IssueCommentEvent)(payload), {
				onNone: () => undefined,
				onSome: ({ action, comment, issue }) =>
					action === "created"
						? found(issue.pull_request ? "pull_request_comment" : "issue_comment", {
								number: issue.number,
								title: issue.title,
								url: comment.html_url,
								text: comment.body,
								branch: null,
								comment: { id: comment.id, kind: "comment" },
							})
						: undefined,
			});
		case "issues":
			return Option.match(Schema.decodeUnknownOption(IssueEvent)(payload), {
				onNone: () => undefined,
				onSome: ({ action, issue }) =>
					action === "opened"
						? found("issue_opened", {
								number: issue.number,
								title: issue.title,
								url: issue.html_url,
								text: issue.body ?? null,
								branch: null,
							})
						: undefined,
			});
		case "check_suite":
			return Option.match(Schema.decodeUnknownOption(CheckSuiteEvent)(payload), {
				onNone: () => undefined,
				onSome: ({ action, check_suite }) =>
					action === "completed" &&
					check_suite.conclusion !== null &&
					FAILED_CONCLUSIONS.includes(check_suite.conclusion)
						? found("checks_failed", {
								number: check_suite.pull_requests[0]?.number ?? null,
								title: null,
								url: `${GitHub.WEB_URL}/${repository.full_name}/commit/${check_suite.head_sha}/checks`,
								text: `The checks on ${check_suite.head_sha} ended: ${check_suite.conclusion}`,
								branch: check_suite.head_branch,
							})
						: undefined,
			});
		case "push":
			return Option.match(Schema.decodeUnknownOption(PushEvent)(payload), {
				onNone: () => undefined,
				onSome: ({ ref, deleted, compare, commits }) =>
					ref.startsWith(BRANCH_REF_PREFIX) && !deleted
						? found("push", {
								number: null,
								title: null,
								url: compare,
								text: commits
									.slice(0, MAX_PUSHED_COMMITS)
									.map((commit) => `${commit.id.slice(0, 7)} ${commit.message.split("\n")[0]}`)
									.join("\n"),
								branch: ref.slice(BRANCH_REF_PREFIX.length),
							})
						: undefined,
			});
		default:
			return undefined;
	}
}

const BRANCH_REF_PREFIX = "refs/heads/";
const OPENED_ACTIONS: readonly string[] = ["opened", "reopened", "ready_for_review"];
const FAILED_CONCLUSIONS: readonly string[] = ["failure", "timed_out"];
const REVIEW_STATES: Readonly<Record<string, string>> = {
	approved: "Approved",
	changes_requested: "Changes requested",
	commented: "Commented",
};

function aboutPullRequest(pullRequest: typeof PullRequest.Type) {
	return { number: pullRequest.number, title: pullRequest.title, branch: pullRequest.head.ref };
}

const Common = Schema.Struct({
	repository: Schema.Struct({ full_name: Schema.String }),
	sender: Schema.Struct({ login: Schema.String }),
});

const PullRequest = Schema.Struct({
	number: Schema.Int,
	title: Schema.String,
	html_url: Schema.String,
	body: Schema.NullOr(Schema.String),
	head: Schema.Struct({ ref: Schema.String }),
});

const PullRequestEvent = Schema.Struct({ action: Schema.String, pull_request: PullRequest });

const ReviewEvent = Schema.Struct({
	action: Schema.String,
	pull_request: PullRequest,
	review: Schema.Struct({
		state: Schema.String,
		body: Schema.NullOr(Schema.String),
		html_url: Schema.String,
	}),
});

const ReviewCommentEvent = Schema.Struct({
	action: Schema.String,
	pull_request: PullRequest,
	comment: Schema.Struct({
		id: Schema.Int,
		body: Schema.String,
		path: Schema.String,
		html_url: Schema.String,
	}),
});

const Issue = Schema.Struct({
	number: Schema.Int,
	title: Schema.String,
	html_url: Schema.String,
	body: Schema.optional(Schema.NullOr(Schema.String)),
	/** Present when the issue is a pull request. */
	pull_request: Schema.optional(Schema.Unknown),
});

const IssueCommentEvent = Schema.Struct({
	action: Schema.String,
	issue: Issue,
	comment: Schema.Struct({ id: Schema.Int, body: Schema.String, html_url: Schema.String }),
});

const IssueEvent = Schema.Struct({ action: Schema.String, issue: Issue });

const CheckSuiteEvent = Schema.Struct({
	action: Schema.String,
	check_suite: Schema.Struct({
		conclusion: Schema.NullOr(Schema.String),
		head_sha: Schema.String,
		head_branch: Schema.NullOr(Schema.String),
		pull_requests: Schema.Array(Schema.Struct({ number: Schema.Int })),
	}),
});

const PushEvent = Schema.Struct({
	ref: Schema.String,
	deleted: Schema.Boolean,
	compare: Schema.String,
	commits: Schema.Array(Schema.Struct({ id: Schema.String, message: Schema.String })),
});
