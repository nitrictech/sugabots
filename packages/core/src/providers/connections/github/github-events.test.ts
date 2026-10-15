import { describe, expect, it } from "vitest";
import { activityOf } from "./github-events.ts";

const APP = "acme-sugabots";
const repository = { full_name: "acme/web" };
const pullRequest = {
	number: 3,
	title: "Fix the login",
	html_url: "https://github.com/acme/web/pull/3",
	body: "It redirects home.",
	head: { ref: "fix-login" },
};

/** What GitHub's deliveries say happened, as a routine's run is told. */
describe("GitHub's events", () => {
	it("tells a review on a pull request, with its verdict and words", () => {
		const activity = activityOf(
			"pull_request_review",
			{
				action: "submitted",
				repository,
				sender: { login: "octocat" },
				pull_request: pullRequest,
				review: {
					state: "changes_requested",
					body: "Keep the deep link.",
					html_url: "https://github.com/acme/web/pull/3#pullrequestreview-1",
				},
			},
			APP,
		);

		expect(activity).toEqual({
			event: "pull_request_review",
			repository: "acme/web",
			sender: "octocat",
			url: "https://github.com/acme/web/pull/3#pullrequestreview-1",
			number: 3,
			title: "Fix the login",
			text: "Changes requested\n\nKeep the deep link.",
			branch: "fix-login",
		});
	});

	it("tells a comment on a pull request apart from one on an issue", () => {
		const comment = (issue: object) =>
			activityOf(
				"issue_comment",
				{
					action: "created",
					repository,
					sender: { login: "octocat" },
					issue: {
						number: 4,
						title: "Login",
						html_url: "https://github.com/acme/web/issues/4",
						...issue,
					},
					comment: { body: "Any news?", html_url: "https://github.com/acme/web/issues/4#c1" },
				},
				APP,
			)?.event;

		expect(comment({ pull_request: { url: "…" } })).toBe("pull_request_comment");
		expect(comment({})).toBe("issue_comment");
	});

	it("leaves out what the workspace's own app did, so a routine can't set itself off", () => {
		const activity = activityOf(
			"push",
			{
				ref: "refs/heads/sugabots/fix",
				deleted: false,
				compare: "https://github.com/acme/web/compare/a...b",
				commits: [{ id: "b".repeat(40), message: "Fix it" }],
				repository,
				sender: { login: `${APP}[bot]` },
			},
			APP,
		);

		expect(activity).toBeUndefined();
	});

	it("tells only checks that failed, and only a pull request's opening, not every change to it", () => {
		const suite = (conclusion: string) =>
			activityOf(
				"check_suite",
				{
					action: "completed",
					repository,
					sender: { login: "github-actions[bot]" },
					check_suite: {
						conclusion,
						head_sha: "c".repeat(40),
						head_branch: "fix-login",
						pull_requests: [{ number: 3 }],
					},
				},
				APP,
			)?.event;
		const pullRequestEvent = (action: string) =>
			activityOf(
				"pull_request",
				{ action, repository, sender: { login: "octocat" }, pull_request: pullRequest },
				APP,
			)?.event;

		expect([suite("failure"), suite("success")]).toEqual(["checks_failed", undefined]);
		expect([pullRequestEvent("opened"), pullRequestEvent("synchronize")]).toEqual([
			"pull_request_opened",
			undefined,
		]);
	});
});
