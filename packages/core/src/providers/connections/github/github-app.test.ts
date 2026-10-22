import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CurrentActor } from "../../../authorization/current-actor.ts";
import { Credentials } from "../../../credentials/credentials.ts";
import { closeDatabase, runOnPostgres } from "../../../database/testing.ts";
import { onPostgresAs } from "../../../workspaces/testing.ts";
import { connectionsIn } from "../connection-reads.ts";
import {
	INSTALLATION_ID,
	installedConnection,
	MANIFEST_CODE,
	OTHER_INSTALLATION_ID,
	reachingGitHub,
	standInGitHub,
	stateIn,
	workspaceWithPod,
} from "./github.test-support.ts";
import { GitHubApps } from "./github-app.ts";
import { GitHubConnections } from "./github-connections.ts";

const servedAt = (publicUrl: string) =>
	runOnPostgres(
		Effect.all([GitHubApps.Service, GitHubConnections.Service]).pipe(
			Effect.provide(Layer.mergeAll(GitHubApps.layer, GitHubConnections.layer)),
			Effect.provide(reachingGitHub(standInGitHub().fetch, publicUrl)),
		),
	);

const listedIn = (pod: { workspaceId: string; podId: string }) =>
	runOnPostgres(
		Effect.flatMap(Credentials.Service, (cipher) =>
			connectionsIn(pod.workspaceId, pod.podId, cipher),
		),
	);

/** How long after its step a setup state is no longer taken: longer than its lifetime. */
const AFTER_STATE_EXPIRES_MILLISECONDS = 2 * 60 * 60 * 1000;

/** A pod's own GitHub App, made and installed through GitHub's pages, against Postgres. */
describe.skipIf(!process.env.DATABASE_URL)("GitHub Apps, against Postgres", () => {
	let gitHubApps: GitHubApps.Interface;

	beforeAll(async () => {
		[gitHubApps] = await servedAt("https://sugabots.example.com");
	});

	afterAll(closeDatabase);

	const as = (userId: string) => onPostgresAs(userId)(gitHubApps);

	it("makes the pod's app from a manifest, for someone who manages the pod's connections", async () => {
		const { podId, adminId, memberId } = await workspaceWithPod("Make");

		await expect(as(memberId).start({ podId, organization: "acme" })).rejects.toMatchObject({
			_tag: "ActionForbidden",
		});
		const form = await as(adminId).start({ podId, organization: "acme" });

		expect(form.url).toMatch(/^https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?/);
		expect(JSON.parse(form.manifest)).toMatchObject({
			name: expect.stringMatching(/^Sugabots Builders [0-9a-f]{4}$/),
			redirect_url: "https://sugabots.example.com/api/connections/github/made",
			setup_url: "https://sugabots.example.com/api/connections/github/installed",
			default_permissions: { contents: "write", pull_requests: "write" },
			hook_attributes: {
				url: expect.stringMatching(
					/^https:\/\/sugabots\.example\.com\/api\/hooks\/connections\/[0-9a-f-]{36}$/,
				),
				active: true,
			},
			default_events: expect.arrayContaining(["pull_request", "issue_comment"]),
			public: false,
		});
	});

	it("makes the pod's GitHub connection once GitHub has made the app, signed in once it is installed", async () => {
		const fixture = await workspaceWithPod("Install");
		const { workspaceId, podId, adminId, memberId } = fixture;
		const form = await as(adminId).start({ podId, organization: undefined });
		const state = stateIn(form.url);
		const webhookUrl = JSON.parse(form.manifest).hook_attributes.url as string;

		const someoneElse = await as(memberId).made({ code: MANIFEST_CODE, state });
		const made = await as(adminId).made({ code: MANIFEST_CODE, state });

		expect(someoneElse).toEqual({ kind: "failed", pod: undefined, failure: "expired" });
		if (made.kind !== "next") throw new Error(`Not made: ${JSON.stringify(made)}`);
		expect(made.url).toMatch(/^https:\/\/github\.com\/apps\/acme-sugabots\/installations\/new\?/);
		const [pending] = await listedIn(fixture);
		expect(pending).toMatchObject({
			kind: "github",
			url: "https://github.com/apps/acme-sugabots",
			signedIn: false,
			appSettingsUrl: "https://github.com/organizations/acme/settings/apps/acme-sugabots",
		});
		expect(webhookUrl.endsWith(`/${pending?.id}`)).toBe(true);

		const notOurs = await as(adminId).installed({ installationId: 999, state: stateIn(made.url) });
		const installed = await as(adminId).installed({
			installationId: INSTALLATION_ID,
			state: stateIn(made.url),
		});

		expect(notOurs).toEqual({ kind: "failed", pod: { workspaceId, podId }, failure: "github" });
		expect(installed).toEqual({
			kind: "done",
			pod: { workspaceId, podId },
			connectionId: pending?.id,
		});
		expect(await listedIn(fixture)).toMatchObject([
			{ id: pending?.id, url: "https://github.com/acme", signedIn: true },
		]);
	});

	it("records the app installed again, on another account", async () => {
		const fixture = await workspaceWithPod("Again");
		const { workspaceId, podId, adminId, memberId } = fixture;
		const connectionId = await installedConnection(gitHubApps, fixture);

		await expect(as(memberId).installUrl({ podId, connectionId })).rejects.toMatchObject({
			_tag: "ActionForbidden",
		});
		// GitHub sends people back here after they change what an installation reaches.
		const url = await as(adminId).installUrl({ podId, connectionId });
		const again = await as(adminId).installed({
			installationId: OTHER_INSTALLATION_ID,
			state: stateIn(url),
		});

		expect(url).toMatch(/^https:\/\/github\.com\/apps\/acme-sugabots\/installations\/new\?/);
		expect(again).toEqual({
			kind: "done",
			pod: { workspaceId, podId },
			connectionId,
		});
		expect(await listedIn(fixture)).toMatchObject([{ url: "https://github.com/acme-labs" }]);
	});

	it("keeps a pod to one GitHub connection", async () => {
		const fixture = await workspaceWithPod("One");
		const { workspaceId, podId, adminId } = fixture;
		const first = await as(adminId).start({ podId, organization: undefined });
		const second = await as(adminId).start({ podId, organization: undefined });
		await as(adminId).made({ code: MANIFEST_CODE, state: stateIn(first.url) });

		// The second app was started before the first was made.
		const meanwhile = await as(adminId).made({ code: MANIFEST_CODE, state: stateIn(second.url) });

		expect(meanwhile).toEqual({ kind: "failed", pod: { workspaceId, podId }, failure: "github" });
		await expect(as(adminId).start({ podId, organization: undefined })).rejects.toMatchObject({
			_tag: "PodHasGitHubConnection",
		});
		expect(await listedIn(fixture)).toHaveLength(1);
	});

	it("refuses a step's state used for another step", async () => {
		const { podId, adminId } = await workspaceWithPod("Steps");
		const form = await as(adminId).start({ podId, organization: undefined });

		const outcome = await as(adminId).installed({
			installationId: INSTALLATION_ID,
			state: stateIn(form.url),
		});

		expect(outcome).toEqual({ kind: "failed", pod: undefined, failure: "expired" });
	});

	it("refuses a step's state once it has expired", async () => {
		const fixture = await workspaceWithPod("Expired");
		const { adminId, podId } = fixture;
		const form = await as(adminId).start({ podId, organization: undefined });

		const outcome = await runOnPostgres(
			Effect.gen(function* () {
				yield* TestClock.setTime(Date.now() + AFTER_STATE_EXPIRES_MILLISECONDS);
				return yield* gitHubApps.made({ code: MANIFEST_CODE, state: stateIn(form.url) });
			}).pipe(
				CurrentActor.provide(CurrentActor.AuthenticatedUserId.vouchedFor(adminId)),
				Effect.provide(TestClock.layer()),
			),
		);

		expect(outcome).toEqual({ kind: "failed", pod: undefined, failure: "expired" });
		expect(await listedIn(fixture)).toEqual([]);
	});

	it("says the person declined, for the pod the step was for", async () => {
		const { workspaceId, podId, adminId } = await workspaceWithPod("Declined");
		const form = await as(adminId).start({ podId, organization: undefined });

		const outcome = await as(adminId).made({ code: undefined, state: stateIn(form.url) });

		expect(outcome).toEqual({ kind: "failed", pod: { workspaceId, podId }, failure: "cancelled" });
	});

	it("makes an app without a webhook when GitHub couldn't reach this installation", async () => {
		const [local] = await servedAt("http://sugabots.localhost:3000");
		const { podId, adminId } = await workspaceWithPod("Local");

		const form = await onPostgresAs(adminId)(local).start({ podId, organization: undefined });

		const manifest = JSON.parse(form.manifest);
		expect(manifest).not.toHaveProperty("hook_attributes");
		expect(manifest.default_events).toEqual([]);
	});
});
