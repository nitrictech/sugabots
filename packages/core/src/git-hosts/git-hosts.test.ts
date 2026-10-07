import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { Cause, Effect, Exit, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CurrentActor } from "../authorization/current-actor.ts";
import { agent, pod, podMember, user, workspace, workspaceMember } from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import { Installation } from "../installation/installation.ts";
import { Egress } from "../providers/network/egress.ts";
import { GitHosts } from "./git-hosts.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});

const INSTALLATION_ID = 7;
const WEBHOOK_SECRET = "the-webhook-secret";

/** What GitHub was asked, by path, for checks on what Sugabots sent. */
const asked: { path: string; body: unknown }[] = [];

/**
 * GitHub as a workspace's app sees it: it makes the app from a manifest,
 * finds the app's one installation only with a token signed by the app's
 * key, and lists two repositories on the account it is installed on.
 */
const github: typeof fetch = async (input, init) => {
	const url = new URL(String(input));
	const path = url.pathname;
	const body = init?.body ? JSON.parse(String(init.body)) : undefined;
	asked.push({ path, body });
	const json = (value: unknown, status = 200) => Response.json(value, { status });
	const bearer = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
	if (path === "/app-manifests/the-code/conversions") {
		return json(
			{
				id: 42,
				slug: "acme-sugabots",
				name: "Acme Sugabots",
				pem: privateKey,
				webhook_secret: WEBHOOK_SECRET,
			},
			201,
		);
	}
	if (path.startsWith("/app/installations/") && init?.method === "GET") {
		if (!signedByApp(bearer)) return json({ message: "Bad credentials" }, 401);
		return path === `/app/installations/${INSTALLATION_ID}`
			? json({ id: INSTALLATION_ID, account: { login: "acme" } })
			: json({ message: "Not Found" }, 404);
	}
	if (path === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
		if (!signedByApp(bearer)) return json({ message: "Bad credentials" }, 401);
		return json({ token: `token-${asked.length}`, expires_at: "2099-01-01T00:00:00Z" }, 201);
	}
	if (path === "/installation/repositories") {
		return json({
			total_count: 2,
			repositories: [
				{ full_name: "acme/web", private: true },
				{ full_name: "acme/infra", private: true },
			],
		});
	}
	if (path === "/repos/acme/web") return json({ default_branch: "main" });
	if (path === "/repos/acme/web/pulls") {
		return json({ number: 12, html_url: "https://github.com/acme/web/pull/12" }, 201);
	}
	return json({ message: "Not Found" }, 404);
};

function signedByApp(jwt: string) {
	const [header, payload, signature] = jwt.split(".");
	if (!header || !payload || !signature) return false;
	return createVerify("RSA-SHA256")
		.update(`${header}.${payload}`)
		.verify(publicKey, signature, "base64url");
}

const servedAt = (publicUrl: string) =>
	Layer.mergeAll(
		Layer.succeed(Egress.Service, {
			providers: { for: () => github },
			validateProviderUrl: () => Effect.void,
			oauth: github,
			webFetch: github,
		}),
		Layer.succeed(Installation.Service, Installation.fromUrls({ isProduction: false, publicUrl })),
	);

const gitHostsServedAt = (publicUrl: string) =>
	runOnPostgres(
		Effect.provide(GitHosts.Service, GitHosts.layer.pipe(Layer.provide(servedAt(publicUrl)))),
	);

/** A workspace's GitHub App and its pods' repositories, against Postgres and a stand-in GitHub. */
describe.skipIf(!process.env.DATABASE_URL)("git hosts, against Postgres", () => {
	let gitHosts: GitHosts.Interface;
	let workspaceId: string;
	let podId: string;
	let adminId: string;
	let memberId: string;
	let agentId: string;

	beforeAll(async () => {
		gitHosts = await gitHostsServedAt("https://sugabots.example.com");
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Git ${suffix}`, slug: `git-${suffix}` })
				.returning(),
		);
		const [admin, member] = await onDatabase((db) =>
			db
				.insert(user)
				.values([
					{ name: "Ada", email: `git-ada-${suffix}@example.com` },
					{ name: "Kim", email: `git-kim-${suffix}@example.com` },
				])
				.returning(),
		);
		if (!space || !admin || !member) throw new Error("fixture");
		workspaceId = space.id;
		adminId = admin.id;
		memberId = member.id;
		await onDatabase((db) =>
			db.insert(workspaceMember).values([
				{ workspaceId, userId: adminId, role: "admin" },
				{ workspaceId, userId: memberId, role: "member" },
			]),
		);
		const [shared] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId,
					ownerId: adminId,
					kind: "shared",
					name: "Builders",
					slug: `builders-${suffix}`,
					createdById: adminId,
				})
				.returning(),
		);
		if (!shared) throw new Error("fixture");
		podId = shared.id;
		await onDatabase((db) => db.insert(podMember).values({ workspaceId, podId, userId: memberId }));
		const [bot] = await onDatabase((db) =>
			db
				.insert(agent)
				.values({
					workspaceId,
					podId,
					name: "Fixer",
					handle: `fixer-${suffix}`,
					color: "green",
					face: "pill",
					model: "no-such-model",
					createdById: adminId,
				})
				.returning(),
		);
		if (!bot) throw new Error("fixture");
		agentId = bot.id;
	});

	afterAll(closeDatabase);

	const as = <A, E>(userId: string, effect: Effect.Effect<A, E, CurrentActor.Service>) =>
		runOnPostgres(
			Effect.exit(
				effect.pipe(CurrentActor.provide(CurrentActor.AuthenticatedUserId.vouchedFor(userId))),
			),
		);

	const succeeded = <A, E>(exit: Exit.Exit<A, E>) => {
		if (!Exit.isSuccess(exit)) throw new Error(exit.toString());
		return exit.value;
	};

	const stateIn = (url: string) => new URL(url).searchParams.get("state") ?? undefined;

	it("makes the workspace's app from a manifest and records the account it is installed on", async () => {
		const form = succeeded(
			await as(adminId, gitHosts.startGitHubApp({ workspace: workspaceId, organization: "acme" })),
		);
		const state = stateIn(form.url);
		expect(form.url).toMatch(/^https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?/);
		expect(JSON.parse(form.manifest)).toMatchObject({
			redirect_url: "https://sugabots.example.com/api/git-hosts/github/made",
			setup_url: "https://sugabots.example.com/api/git-hosts/github/installed",
			default_permissions: { contents: "write", pull_requests: "write" },
			hook_attributes: {
				url: expect.stringMatching(
					/^https:\/\/sugabots\.example\.com\/api\/hooks\/git-hosts\/[0-9a-f-]{36}$/,
				),
				active: true,
			},
			default_events: expect.arrayContaining(["pull_request", "check_run"]),
		});

		const someoneElse = succeeded(
			await as(memberId, gitHosts.gitHubAppMade({ code: "the-code", state })),
		);
		const made = succeeded(await as(adminId, gitHosts.gitHubAppMade({ code: "the-code", state })));

		expect(someoneElse).toEqual({ kind: "failed", workspaceId: undefined, failure: "expired" });
		if (made.kind !== "next") throw new Error(`Not made: ${JSON.stringify(made)}`);
		expect(made.url).toMatch(/^https:\/\/github\.com\/apps\/acme-sugabots\/installations\/new\?/);

		const notOurs = succeeded(
			await as(
				adminId,
				gitHosts.gitHubAppInstalled({ installationId: 999, state: stateIn(made.url) }),
			),
		);
		const installed = succeeded(
			await as(
				adminId,
				gitHosts.gitHubAppInstalled({ installationId: INSTALLATION_ID, state: stateIn(made.url) }),
			),
		);

		expect(notOurs).toEqual({ kind: "failed", workspaceId, failure: "github" });
		expect(installed).toEqual({ kind: "done", workspaceId });
		const hosts = succeeded(await as(adminId, gitHosts.list(workspaceId)));
		expect(hosts.map(({ name, account }) => ({ name, account }))).toEqual([
			{ name: "Acme Sugabots", account: "acme" },
		]);
	});

	it("makes an app without a webhook when GitHub couldn't reach this install", async () => {
		const local = await gitHostsServedAt("http://sugabots.localhost:3000");

		const form = succeeded(
			await as(adminId, local.startGitHubApp({ workspace: workspaceId, organization: undefined })),
		);

		const manifest = JSON.parse(form.manifest);
		expect(manifest).not.toHaveProperty("hook_attributes");
		expect(manifest.default_events).toEqual([]);
	});

	it("admits only deliveries signed with the app's webhook secret", async () => {
		const [host] = succeeded(await as(adminId, gitHosts.list(workspaceId)));
		if (!host) throw new Error("No app; the setup case runs first");
		const body = JSON.stringify({ action: "opened" });
		const signedWith = (secret: string) =>
			`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
		const deliver = (gitHostId: string, signature: string | undefined) =>
			runOnPostgres(
				Effect.exit(gitHosts.delivery({ gitHostId, event: "pull_request", body, signature })),
			);

		const signed = await deliver(host.id, signedWith(WEBHOOK_SECRET));
		const forged = await deliver(host.id, signedWith("a-guess"));
		const unsigned = await deliver(host.id, undefined);
		const nowhere = await deliver(
			"0199a3a0-0000-7000-8000-000000000000",
			signedWith(WEBHOOK_SECRET),
		);

		expect(Exit.isSuccess(signed)).toBe(true);
		for (const refused of [forged, unsigned, nowhere]) {
			expect(Exit.isFailure(refused) && refused.toString()).toContain("DeliveryRefused");
		}
	});

	it("lets someone who manages the pod's connections add only a repository the app reaches", async () => {
		const [host] = succeeded(await as(adminId, gitHosts.list(workspaceId)));
		if (!host) throw new Error("No app; the setup case runs first");
		const repository = (name: string) => ({ podId, gitHostId: host.id, repository: name });

		const forbidden = await as(memberId, gitHosts.addRepository(repository("acme/web")));
		const unreachable = await as(adminId, gitHosts.addRepository(repository("acme/secret")));
		const added = succeeded(await as(adminId, gitHosts.addRepository(repository("acme/web"))));

		expect(Exit.isFailure(forbidden) && forbidden.toString()).toContain("ActionForbidden");
		expect(Exit.isFailure(unreachable) && unreachable.toString()).toContain(
			"RepositoryUnreachable",
		);
		expect(added.repositories.map((one) => [one.repository, one.addedByName])).toEqual([
			["acme/web", "Ada"],
		]);
	});

	it("signs the sandbox in to read only the pod's repositories", async () => {
		asked.length = 0;

		const access = await runOnPostgres(gitHosts.readAccess({ workspaceId, podId }));

		expect(access.map(({ account }) => account)).toEqual(["acme"]);
		expect(asked.find((call) => call.path.endsWith("/access_tokens"))?.body).toEqual({
			repositories: ["web"],
			permissions: expect.objectContaining({ contents: "read", pull_requests: "read" }),
		});
	});

	it("opens a pull request only on the pod's repositories, saying which agent opened it and who allowed it", async () => {
		// Vouched for here; `allowedRequest` finds one from an allowed tool call.
		const request = {
			pod: { workspaceId, podId },
			decidedById: adminId,
		} as GitHosts.AllowedRequest;
		const pullRequest = (repository: string) =>
			runOnPostgres(
				Effect.exit(
					gitHosts.openPullRequest(request, {
						repository,
						head: "sugabots/fix",
						base: undefined,
						title: "Fix it",
						body: "What changed.",
						draft: false,
						agentId,
					}),
				),
			);
		asked.length = 0;

		const elsewhere = await pullRequest("acme/infra");
		const opened = succeeded(await pullRequest("acme/web"));

		expect(Exit.isFailure(elsewhere) && Cause.squash(elsewhere.cause)).toMatchObject({
			_tag: "NotPodRepository",
			repositories: ["acme/web"],
		});
		expect(opened).toEqual({ number: 12, url: "https://github.com/acme/web/pull/12" });
		const sent = asked.find((call) => call.path === "/repos/acme/web/pulls")?.body;
		expect(sent).toMatchObject({ head: "sugabots/fix", base: "main", title: "Fix it" });
		expect((sent as { body: string }).body).toMatch(
			/^What changed\.\n\n---\n\*\*Fixer\*\*.*Ada allowed/,
		);
	});
});
