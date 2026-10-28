import { createHmac } from "node:crypto";
import { Effect, Layer, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, runOnPostgres } from "../../../database/testing.ts";
import { onPostgresAs } from "../../../workspaces/testing.ts";
import type { Connected } from "./connected.ts";
import {
	INSTALLATION_ID,
	installedConnection,
	json,
	listsRepositories,
	madeConnection,
	mintsTokens,
	type Route,
	reachingGitHub,
	standInGitHub,
	WEBHOOK_SECRET,
	workspaceWithPod,
} from "./github.test-support.ts";
import { GitHubApps } from "./github-app.ts";
import { GitHubConnections } from "./github-connections.ts";
import * as GitHubReads from "./github-reads.ts";

/** What GitHub shows the stand-in's app, `acme-sugabots`, as the author of. */
const BOT_LOGIN = "acme-sugabots[bot]";

/**
 * A pod's GitHub connection, its own app installed on `acme`, which reaches
 * `acme/web` and `acme/infra`, against Postgres.
 */
describe.skipIf(!process.env.DATABASE_URL)("GitHub connections, against Postgres", () => {
	// Once set, GitHub has renamed `acme/web` to `acme/website`, keeping its id.
	let renamed = false;
	const listsRenamed: Route = ({ path }) =>
		renamed && path === "/installation/repositories"
			? json({
					total_count: 2,
					repositories: [
						{ id: 101, full_name: "acme/website", private: true },
						{ id: 102, full_name: "acme/infra", private: false },
					],
				})
			: undefined;
	// #5 is from a bot's branch, #6 from someone's, and #7 from a bot-like branch of a fork.
	const pullRequests: Route = ({ method, path }) => {
		const pull = /^\/repos\/acme\/web\/pulls\/(\d+)$/.exec(path);
		const head = {
			5: ["sugabots/fix-login", "acme/web"],
			6: ["fix-login", "acme/web"],
			7: ["sugabots/fix-login", "mallory/web"],
		}[Number(pull?.[1])];
		if (path === "/graphql") return json({ data: {} });
		if (!pull || !head) return undefined;
		const [ref, fullName] = head;
		const url = `https://github.com/acme/web/pull/${pull[1]}`;
		return method === "PATCH"
			? json({ number: Number(pull[1]), html_url: url })
			: json({
					node_id: `PR_${pull[1]}`,
					draft: true,
					head: { ref, repo: { full_name: fullName } },
				});
	};
	// Issue #20 and comment 30 are the app's own; #21, pull request #22 and comment 31 are someone's.
	const issuesAndComments: Route = ({ method, path }) => {
		const issue = /^\/repos\/acme\/web\/issues\/(\d+)$/.exec(path);
		if (issue) {
			const number = Number(issue[1]);
			const author = number === 20 ? BOT_LOGIN : "octocat";
			return json({
				number,
				title: "Login",
				state: "open",
				body: null,
				labels: [],
				created_at: "2026-10-27T00:00:00Z",
				html_url: `https://github.com/acme/web/issues/${number}`,
				user: { login: author },
				...(number === 22 ? { pull_request: {} } : {}),
			});
		}
		const comment = /^\/repos\/acme\/web\/issues\/comments\/(\d+)$/.exec(path);
		if (!comment) return undefined;
		const id = Number(comment[1]);
		if (method === "DELETE") return new Response(null, { status: 204 });
		return json({
			id,
			html_url: `https://github.com/acme/web/issues/20#issuecomment-${id}`,
			user: { login: id === 30 ? BOT_LOGIN : "octocat" },
		});
	};
	// Comment 41 on #5's code answers comment 40, which starts its thread.
	const codeComments: Route = ({ method, path }) => {
		if (method === "GET" && path === "/repos/acme/web/pulls/comments/41") {
			return json({ user: { login: "octocat" }, in_reply_to_id: 40 });
		}
		return method === "POST" && path === "/repos/acme/web/pulls/5/comments/40/replies"
			? json({ id: 42, html_url: "https://github.com/acme/web/pull/5#discussion_r42" }, 201)
			: undefined;
	};
	// #23 has eight pages of comments, one on each, the eighth newest.
	const longThread: Route = ({ path, search }) => {
		if (path !== "/repos/acme/web/issues/23/comments") return undefined;
		const page = Number(new URLSearchParams(search).get("page"));
		const last = "https://api.github.com/repositories/101/issues/23/comments?per_page=100&page=8";
		return Response.json(
			[{ id: page, user: { login: "octocat" }, body: `Comment ${page}`, created_at: "" }],
			{
				headers: {
					link: `<${last.replace("page=8", `page=${page + 1}`)}>; rel="next", <${last}>; rel="last"`,
				},
			},
		);
	};
	const searches: Route = ({ path }) =>
		path === "/search/issues" ? json({ total_count: 0, items: [] }) : undefined;
	// Job 9's log is at GitHub's storage, where its address is signed for it; job 10's is long.
	const jobLogs: Route = ({ path }) => {
		const job = /^\/repos\/acme\/web\/actions\/jobs\/(\d+)\/logs$/.exec(path)?.[1];
		if (job) {
			return new Response(null, {
				status: 302,
				headers: { location: `https://storage.example.com/logs/${job}?signature=signed` },
			});
		}
		if (path === "/logs/10") {
			const lines = Array.from(
				{ length: 5_000 },
				(_, at) => `2026-10-27T01:00:00.0000000Z Step ${at}`,
			);
			return new Response(`${lines.join("\n")}\n`);
		}
		return path === "/logs/9"
			? new Response(
					"2026-10-27T01:00:00.0000000Z Run tests\n2026-10-27T01:00:01.0000000Z FAIL login.test.ts\n",
				)
			: undefined;
	};
	// Until set, the installation refuses tokens that write issues, as an app made before they were asked for.
	let grantsIssues = true;
	// Once set, the installation no longer reaches the connection's repositories.
	let lostRepositories = false;
	const refusesTokens: Route = ({ method, path, body }) => {
		if (method !== "POST" || !path.endsWith("/access_tokens")) return undefined;
		if (lostRepositories) {
			return json(
				{
					message:
						"There is at least one repository that does not exist or is not accessible to the parent installation.",
				},
				422,
			);
		}
		return !grantsIssues && JSON.stringify(body).includes('"issues":"write"')
			? json({ message: "The permissions requested are not granted to this installation." }, 422)
			: undefined;
	};
	const github = standInGitHub(
		refusesTokens,
		mintsTokens,
		listsRenamed,
		listsRepositories,
		pullRequests,
		issuesAndComments,
		codeComments,
		longThread,
		searches,
		jobLogs,
	);
	let connections: GitHubConnections.Interface;
	let gitHubApps: GitHubApps.Interface;
	let fixture: Awaited<ReturnType<typeof workspaceWithPod>>;
	let connectionId: string;

	beforeAll(async () => {
		[gitHubApps, connections] = await runOnPostgres(
			Effect.all([GitHubApps.Service, GitHubConnections.Service]).pipe(
				Effect.provide(Layer.mergeAll(GitHubApps.layer, GitHubConnections.layer)),
				Effect.provide(reachingGitHub(github.fetch, "https://sugabots.example.com")),
			),
		);
		fixture = await workspaceWithPod("Connections");
		connectionId = await installedConnection(gitHubApps, fixture);
	});

	afterAll(closeDatabase);

	const as = (userId: string) => onPostgresAs(userId)(connections);
	const pod = () => ({ workspaceId: fixture.workspaceId, podId: fixture.podId });

	it("lists what the app reaches, for someone who manages the pod's connections", async () => {
		const { podId, adminId, memberId } = fixture;

		await expect(as(memberId).reachableRepositories({ podId, connectionId })).rejects.toMatchObject(
			{ _tag: "ActionForbidden" },
		);
		expect(await as(adminId).reachableRepositories({ podId, connectionId })).toEqual([
			{ repository: "acme/web", private: true },
			{ repository: "acme/infra", private: false },
		]);
	});

	it("adds a repository the app reaches, as GitHub writes it, for someone who manages the pod's connections", async () => {
		const { podId, adminId, memberId } = fixture;

		await expect(
			as(memberId).addRepository({ podId, connectionId, repository: "acme/web" }),
		).rejects.toMatchObject({ _tag: "ActionForbidden" });
		await expect(
			as(adminId).addRepository({ podId, connectionId, repository: "acme-labs/lab" }),
		).rejects.toMatchObject({ _tag: "RepositoryUnreachable" });
		await as(adminId).addRepository({ podId, connectionId, repository: "ACME/Web" });

		expect(await as(memberId).repositories({ podId, connectionId })).toMatchObject({
			account: "acme",
			repositories: [{ repository: "acme/web", addedByName: "Ada" }],
		});
	});

	it("signs the sandbox in to read only the connection's repositories, with git, as its account", async () => {
		const connected = await runOnPostgres(connections.forPod(pod()));
		if (!connected) throw new Error("Not connected");
		github.asked.length = 0;

		const signedIn = await runOnPostgres(connected.sandboxSignIn());

		expect(signedIn.credentials.map(({ host, pathPrefix }) => ({ host, pathPrefix }))).toEqual([
			{ host: "github.com", pathPrefix: "/acme/" },
		]);
		const [git] = signedIn.credentials;
		const token = Buffer.from(
			(git ? Redacted.value(git.value) : "").replace("Basic ", ""),
			"base64",
		).toString();
		expect(token).toMatch(new RegExp(`^x-access-token:token-${INSTALLATION_ID}-\\d+$`));
		const asked = github.asked.find((request) => request.path.endsWith("/access_tokens"));
		expect(asked?.body).toEqual({
			repository_ids: [101],
			permissions: { contents: "read", metadata: "read" },
		});
	});

	it("changes a pull request from a bot's own branch, and no one else's", async () => {
		const connected = await runOnPostgres(connections.forPod(pod()));
		if (!connected) throw new Error("Not connected");
		github.asked.length = 0;
		const change = {
			repository: "acme/web",
			title: "Fix the login",
			body: undefined,
			base: undefined,
			state: undefined,
			draft: false,
		};

		const updated = await runOnPostgres(connected.updatePullRequest({ ...change, number: 5 }));
		for (const number of [6, 7]) {
			await expect(
				runOnPostgres(connected.updatePullRequest({ ...change, number })),
			).rejects.toMatchObject({ _tag: "NotBotPullRequest" });
		}

		expect(updated).toEqual({ number: 5, url: "https://github.com/acme/web/pull/5" });
		const changed = github.asked.filter((request) => request.method !== "GET");
		expect(changed.filter((request) => !request.path.endsWith("/access_tokens"))).toEqual([
			expect.objectContaining({
				path: "/graphql",
				body: expect.objectContaining({ variables: { id: "PR_5" } }),
			}),
			expect.objectContaining({
				method: "PATCH",
				path: "/repos/acme/web/pulls/5",
				body: { title: "Fix the login" },
			}),
		]);
	});

	it("labels and closes anyone's issue, but changes the words only of the app's own, and of a pull request only its labels and assignees", async () => {
		const connected = await runOnPostgres(connections.forPod(pod()));
		if (!connected) throw new Error("Not connected");
		github.asked.length = 0;
		type Change = Parameters<Connected["updateIssue"]>[0];
		const unchanged = {
			repository: "acme/web",
			title: undefined,
			body: undefined,
			state: undefined,
			closedReason: undefined,
			labels: undefined,
			assignees: undefined,
		};
		const update = (number: number, changed: Partial<Change>) =>
			runOnPostgres(connected.updateIssue({ ...unchanged, ...changed, number }));

		await update(21, { labels: ["bug"] });
		await update(21, { state: "closed", closedReason: "duplicate" });
		await update(20, { title: "Login loops" });
		await update(22, { assignees: ["octocat"] });
		await expect(update(21, { title: "Login loops" })).rejects.toMatchObject({
			_tag: "NotBotIssue",
		});
		await expect(update(22, { state: "closed" })).rejects.toMatchObject({
			_tag: "IssueIsPullRequest",
		});

		const patched = github.asked.filter((request) => request.method === "PATCH");
		expect(patched.map(({ path, body }) => ({ path, body }))).toEqual([
			{ path: "/repos/acme/web/issues/21", body: { labels: ["bug"] } },
			{
				path: "/repos/acme/web/issues/21",
				body: { state: "closed", state_reason: "duplicate" },
			},
			{ path: "/repos/acme/web/issues/20", body: { title: "Login loops" } },
			{ path: "/repos/acme/web/issues/22", body: { assignees: ["octocat"] } },
		]);
	});

	it("replies to a comment on code in its thread, through the comment that starts it", async () => {
		const connected = await runOnPostgres(connections.forPod(pod()));
		if (!connected) throw new Error("Not connected");

		const replied = await runOnPostgres(
			connected.replyToCodeComment({
				repository: "acme/web",
				number: 5,
				commentId: 41,
				body: "Done.",
			}),
		);

		expect(replied).toEqual({
			commentId: 42,
			url: "https://github.com/acme/web/pull/5#discussion_r42",
		});
	});

	it("reads a long thread's first and newest comments, saying some between were left out", async () => {
		const connected = await runOnPostgres(connections.forPod(pod()));
		if (!connected) throw new Error("Not connected");

		const read = await runOnPostgres(
			connected.read((http, token) =>
				GitHubReads.getIssue(http, token, { repository: "acme/web", number: 23 }),
			),
		);

		expect(read.comments.map((comment) => comment.body)).toEqual([
			"Comment 1",
			"Comment 5",
			"Comment 6",
			"Comment 7",
			"Comment 8",
		]);
		expect(read.note).toMatch(/left out/);
	});

	it("searches issues unless asked for pull requests, which GitHub requires it to say", async () => {
		const connected = await runOnPostgres(connections.forPod(pod()));
		if (!connected) throw new Error("Not connected");
		github.asked.length = 0;
		const search = (query: string) =>
			runOnPostgres(
				connected.read((http, token) =>
					GitHubReads.searchIssues(http, token, { repository: "acme/web", query, page: 1 }),
				),
			);

		await search("login error");
		await search("is:pr login error");

		const queries = github.asked
			.filter(({ path }) => path === "/search/issues")
			.map(({ search }) => new URLSearchParams(search).get("q"));
		expect(queries).toEqual([
			"login error is:issue repo:acme/web",
			"is:pr login error repo:acme/web",
		]);
	});

	it("tells a repository the installation no longer reaches apart from a permission it lacks", async () => {
		const connected = await runOnPostgres(connections.forPod(pod()));
		if (!connected) throw new Error("Not connected");
		lostRepositories = true;
		try {
			await expect(
				runOnPostgres(
					connected.commentOnIssue({ repository: "acme/web", number: 21, body: "On it." }),
				),
			).rejects.toMatchObject({ _tag: "GitHubRequestFailed", status: 422 });
		} finally {
			lostRepositories = false;
		}
	});

	it("edits and deletes the app's own comments, and no one else's", async () => {
		const connected = await runOnPostgres(connections.forPod(pod()));
		if (!connected) throw new Error("Not connected");
		github.asked.length = 0;
		const comment = { repository: "acme/web", kind: "comment" as const };

		await runOnPostgres(connected.editComment({ ...comment, commentId: 30, body: "Fixed." }));
		await runOnPostgres(connected.deleteComment({ ...comment, commentId: 30 }));
		await expect(
			runOnPostgres(connected.editComment({ ...comment, commentId: 31, body: "Fixed." })),
		).rejects.toMatchObject({ _tag: "NotBotComment", author: "octocat" });
		await expect(
			runOnPostgres(connected.deleteComment({ ...comment, commentId: 31 })),
		).rejects.toMatchObject({ _tag: "NotBotComment" });

		const changed = github.asked.filter(({ method }) => method === "PATCH" || method === "DELETE");
		expect(changed.map(({ method, path }) => `${method} ${path}`)).toEqual([
			"PATCH /repos/acme/web/issues/comments/30",
			"DELETE /repos/acme/web/issues/comments/30",
		]);
	});

	it("says what the app must be granted when its installation hasn't been", async () => {
		const connected = await runOnPostgres(connections.forPod(pod()));
		if (!connected) throw new Error("Not connected");
		grantsIssues = false;
		try {
			await expect(
				runOnPostgres(
					connected.commentOnIssue({ repository: "acme/web", number: 21, body: "On it." }),
				),
			).rejects.toMatchObject({ _tag: "GitHubPermissionNotGranted", permissions: "Issues: write" });
		} finally {
			grantsIssues = true;
		}
	});

	it("reads the end of a job's log from where GitHub keeps it, without sending the token there", async () => {
		const connected = await runOnPostgres(connections.forPod(pod()));
		if (!connected) throw new Error("Not connected");
		github.asked.length = 0;

		const read = await runOnPostgres(connected.jobLog({ repository: "acme/web", jobId: 9 }));

		expect(read).toEqual({ truncated: false, log: "Run tests\nFAIL login.test.ts\n" });
		const fromStorage = github.asked.find(({ path }) => path === "/logs/9");
		expect(fromStorage?.bearer).toBe("");
	});

	it("gives only the end of a long job's log, in whole lines", async () => {
		const connected = await runOnPostgres(connections.forPod(pod()));
		if (!connected) throw new Error("Not connected");

		const read = await runOnPostgres(connected.jobLog({ repository: "acme/web", jobId: 10 }));

		expect(read.truncated).toBe(true);
		expect(read.log.length).toBeLessThanOrEqual(30_000);
		expect(read.log).toMatch(/^Step \d+\n/);
		expect(read.log.endsWith("Step 4999\n")).toBe(true);
	});

	it("adds a repository and removes one, each a change of the connection's configuration", async () => {
		const { podId, adminId } = fixture;
		const connected = await runOnPostgres(connections.forPod(pod()));

		const added = await as(adminId).addRepository({
			podId,
			connectionId,
			repository: "acme/infra",
		});
		const left = await as(adminId).removeRepository({
			podId,
			connectionId,
			repository: "acme/web",
		});
		const after = await runOnPostgres(connections.forPod(pod()));

		expect(added.repositories.map((one) => one.repository)).toEqual(["acme/infra", "acme/web"]);
		expect(left.repositories.map((one) => one.repository)).toEqual(["acme/infra"]);
		expect(after?.connection.configurationRevision).toBe(
			(connected?.connection.configurationRevision ?? 0) + 2,
		);
	});

	it("keeps a repository GitHub renames, by its id", async () => {
		const renaming = await workspaceWithPod("Renaming");
		const { podId, adminId } = renaming;
		const renamedId = await installedConnection(gitHubApps, renaming);
		await as(adminId).addRepository({ podId, connectionId: renamedId, repository: "acme/web" });
		renamed = true;
		try {
			const listed = await as(adminId).addRepository({
				podId,
				connectionId: renamedId,
				repository: "acme/infra",
			});
			const connected = await runOnPostgres(
				connections.forPod({ workspaceId: renaming.workspaceId, podId }),
			);
			github.asked.length = 0;
			await runOnPostgres(connected?.readToken() ?? Effect.void);

			expect(listed.repositories.map((one) => one.repository)).toEqual([
				"acme/infra",
				"acme/website",
			]);
			const asked = github.asked.find((request) => request.path.endsWith("/access_tokens"));
			expect(asked?.body).toMatchObject({ repository_ids: [101, 102] });
		} finally {
			renamed = false;
		}
	});

	it("refuses to choose repositories before the connection's app is installed", async () => {
		const pending = await workspaceWithPod("Pending");
		const { connectionId: pendingId } = await madeConnection(gitHubApps, pending);
		const asAdmin = as(pending.adminId);
		const which = { podId: pending.podId, connectionId: pendingId };

		await expect(asAdmin.reachableRepositories(which)).rejects.toMatchObject({
			_tag: "GitHubAppNotInstalled",
		});
		await expect(asAdmin.addRepository({ ...which, repository: "acme/web" })).rejects.toMatchObject(
			{ _tag: "GitHubAppNotInstalled" },
		);
		expect(await asAdmin.repositories(which)).toEqual({
			account: null,
			repositories: [],
		});
	});

	it("refuses another pod's connection", async () => {
		const other = await workspaceWithPod("Other");

		await expect(
			as(other.adminId).repositories({ podId: other.podId, connectionId }),
		).rejects.toMatchObject({ _tag: "NotGitHubConnection" });
	});

	describe("deliveries to the connection's webhook", () => {
		const body = JSON.stringify({
			action: "opened",
			repository: { full_name: "acme/web" },
			sender: { login: "octocat" },
			pull_request: {
				number: 3,
				title: "Fix the login",
				html_url: "https://github.com/acme/web/pull/3",
				body: null,
				head: { ref: "fix-login" },
			},
		});
		const signed = (secret: string) =>
			`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
		const deliver = (to: string, signature: string) =>
			runOnPostgres(
				connections.receiveDelivery({
					connectionId: to,
					headers: {
						"x-github-event": "pull_request",
						"x-github-delivery": "delivery-1",
						"x-hub-signature-256": signature,
					},
					body,
				}),
			);

		it("takes one its app signed, for the connection's workspace", async () => {
			const delivered = await deliver(connectionId, signed(WEBHOOK_SECRET));

			expect(delivered).toMatchObject({
				workspaceId: fixture.workspaceId,
				connectionId,
				deliveryId: "delivery-1",
				activity: { event: "pull_request_opened", repository: "acme/web", number: 3 },
			});
		});

		it("refuses one signed with another secret, or for no connection", async () => {
			await expect(deliver(connectionId, signed("not-the-secret"))).rejects.toMatchObject({
				_tag: "DeliveryRefused",
			});
			await expect(deliver(crypto.randomUUID(), signed(WEBHOOK_SECRET))).rejects.toMatchObject({
				_tag: "DeliveryRefused",
			});
		});
	});
});
