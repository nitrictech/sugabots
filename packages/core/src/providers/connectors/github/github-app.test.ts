import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CurrentActor } from "../../../authorization/current-actor.ts";
import { closeDatabase, runOnPostgres } from "../../../database/testing.ts";
import { Secrets } from "../../../secrets/secrets.ts";
import { onPostgresAs } from "../../../workspaces/testing.ts";
import { connectorsIn } from "../connector-reads.ts";
import {
	INSTALLATION_ID,
	installedConnector,
	MANIFEST_CODE,
	OTHER_INSTALLATION_ID,
	reachingGitHub,
	standInGitHub,
	stateIn,
	workspaceWithProject,
} from "./github.test-support.ts";
import { GitHubApps } from "./github-app.ts";
import { GitHubConnectors } from "./github-connectors.ts";

const servedAt = (publicUrl: string) =>
	runOnPostgres(
		Effect.all([GitHubApps.Service, GitHubConnectors.Service]).pipe(
			Effect.provide(Layer.mergeAll(GitHubApps.layer, GitHubConnectors.layer)),
			Effect.provide(reachingGitHub(standInGitHub().fetch, publicUrl)),
		),
	);

const listedIn = (owner: { workspaceId: string; projectId: string }) =>
	runOnPostgres(
		Effect.flatMap(Secrets.Service, (cipher) =>
			connectorsIn(owner.workspaceId, owner.projectId, cipher),
		),
	);

/** How long after its step a setup state is no longer taken: longer than its lifetime. */
const AFTER_STATE_EXPIRES_MILLISECONDS = 2 * 60 * 60 * 1000;

/** A project's own GitHub App, made and installed through GitHub's pages, against Postgres. */
describe.skipIf(!process.env.DATABASE_URL)("GitHub Apps, against Postgres", () => {
	let gitHubApps: GitHubApps.Interface;
	let connectors: GitHubConnectors.Interface;

	beforeAll(async () => {
		[gitHubApps, connectors] = await servedAt("https://sugabots.example.com");
	});

	afterAll(closeDatabase);

	const as = (memberId: string) => onPostgresAs(memberId)(gitHubApps);

	it("makes the project's app from a manifest, for someone who manages its connectors", async () => {
		const { projectId, adminId, editorId } = await workspaceWithProject("Make");

		await expect(as(editorId).start({ projectId, organization: "acme" })).rejects.toMatchObject({
			_tag: "ActionForbidden",
		});
		const form = await as(adminId).start({ projectId, organization: "acme" });

		expect(form.url).toMatch(/^https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?/);
		expect(JSON.parse(form.manifest)).toMatchObject({
			name: expect.stringMatching(/^Sugabots Builders [0-9a-f]{4}$/),
			redirect_url: "https://sugabots.example.com/api/connectors/github/made",
			setup_url: "https://sugabots.example.com/api/connectors/github/installed",
			default_permissions: { contents: "write", pull_requests: "write" },
			hook_attributes: {
				url: expect.stringMatching(
					/^https:\/\/sugabots\.example\.com\/api\/webhooks\/connectors\/[0-9a-f-]{36}$/,
				),
				active: true,
			},
			default_events: expect.arrayContaining(["pull_request", "issue_comment"]),
			public: false,
		});
	});

	it("makes a bot's own app in its default project, named for the bot, and returns to that project", async () => {
		const fixture = await workspaceWithProject("Own");
		const { workspaceId, botProjectId, adminId } = fixture;
		const form = await as(adminId).start({ projectId: botProjectId, organization: undefined });
		expect(JSON.parse(form.manifest).name).toMatch(/^Sugabots Builder [0-9a-f]{4}$/);

		const made = await as(adminId).made({ code: MANIFEST_CODE, state: stateIn(form.url) });
		if (made.kind !== "next") throw new Error(`Not made: ${JSON.stringify(made)}`);
		const installed = await as(adminId).installed({
			installationId: INSTALLATION_ID,
			state: stateIn(made.url),
		});

		expect(installed).toMatchObject({
			kind: "done",
			at: { workspaceId, projectId: botProjectId },
		});
		expect(
			await runOnPostgres(connectors.forProject({ workspaceId, projectId: botProjectId })),
		).toBeDefined();
		expect(
			await runOnPostgres(connectors.forProject({ workspaceId, projectId: fixture.projectId })),
		).toBeUndefined();
	});

	it("makes the project's GitHub connector once GitHub has made the app, signed in once it is installed", async () => {
		const fixture = await workspaceWithProject("Install");
		const { workspaceId, projectId, adminId, editorId } = fixture;
		const form = await as(adminId).start({ projectId, organization: undefined });
		const state = stateIn(form.url);
		const webhookUrl = JSON.parse(form.manifest).hook_attributes.url as string;

		const someoneElse = await as(editorId).made({ code: MANIFEST_CODE, state });
		const made = await as(adminId).made({ code: MANIFEST_CODE, state });

		expect(someoneElse).toEqual({ kind: "failed", at: undefined, failure: "expired" });
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
		expect(await runOnPostgres(connectors.forProject(fixture))).toBeUndefined();

		const notOurs = await as(adminId).installed({ installationId: 999, state: stateIn(made.url) });
		const installed = await as(adminId).installed({
			installationId: INSTALLATION_ID,
			state: stateIn(made.url),
		});

		expect(notOurs).toEqual({
			kind: "failed",
			at: { workspaceId, projectId },
			failure: "github",
		});
		expect(installed).toEqual({
			kind: "done",
			at: { workspaceId, projectId },
			connectorId: pending?.id,
		});
		expect(await listedIn(fixture)).toMatchObject([
			{ id: pending?.id, url: "https://github.com/acme", signedIn: true },
		]);
		const connected = await runOnPostgres(connectors.forProject(fixture));
		expect(connected?.account).toBe("acme");
	});

	it("records the app installed again, on another account", async () => {
		const fixture = await workspaceWithProject("Again");
		const { workspaceId, projectId, adminId, editorId } = fixture;
		const connectorId = await installedConnector(gitHubApps, fixture);

		await expect(as(editorId).installUrl({ projectId, connectorId })).rejects.toMatchObject({
			_tag: "ActionForbidden",
		});
		// GitHub sends members back here after they change what an installation reaches.
		const url = await as(adminId).installUrl({ projectId, connectorId });
		const again = await as(adminId).installed({
			installationId: OTHER_INSTALLATION_ID,
			state: stateIn(url),
		});

		expect(url).toMatch(/^https:\/\/github\.com\/apps\/acme-sugabots\/installations\/new\?/);
		expect(again).toEqual({
			kind: "done",
			at: { workspaceId, projectId },
			connectorId,
		});
		expect(await listedIn(fixture)).toMatchObject([{ url: "https://github.com/acme-labs" }]);
		expect((await runOnPostgres(connectors.forProject(fixture)))?.account).toBe("acme-labs");
	});

	it("keeps a bot to one GitHub app", async () => {
		const fixture = await workspaceWithProject("One");
		const { workspaceId, projectId, adminId } = fixture;
		const first = await as(adminId).start({ projectId, organization: undefined });
		const second = await as(adminId).start({ projectId, organization: undefined });
		await as(adminId).made({ code: MANIFEST_CODE, state: stateIn(first.url) });

		// The second app was started before the first was made.
		const meanwhile = await as(adminId).made({ code: MANIFEST_CODE, state: stateIn(second.url) });

		expect(meanwhile).toEqual({
			kind: "failed",
			at: { workspaceId, projectId },
			failure: "github",
		});
		await expect(as(adminId).start({ projectId, organization: undefined })).rejects.toMatchObject({
			_tag: "ProjectHasGitHubConnector",
		});
		expect(await listedIn(fixture)).toHaveLength(1);
	});

	it("refuses a step's state used for another step", async () => {
		const { projectId, adminId } = await workspaceWithProject("Steps");
		const form = await as(adminId).start({ projectId, organization: undefined });

		const outcome = await as(adminId).installed({
			installationId: INSTALLATION_ID,
			state: stateIn(form.url),
		});

		expect(outcome).toEqual({ kind: "failed", at: undefined, failure: "expired" });
	});

	it("refuses a step's state once it has expired", async () => {
		const fixture = await workspaceWithProject("Expired");
		const { adminId, projectId } = fixture;
		const form = await as(adminId).start({ projectId, organization: undefined });

		const outcome = await runOnPostgres(
			Effect.gen(function* () {
				yield* TestClock.setTime(Date.now() + AFTER_STATE_EXPIRES_MILLISECONDS);
				return yield* gitHubApps.made({ code: MANIFEST_CODE, state: stateIn(form.url) });
			}).pipe(
				CurrentActor.provide(CurrentActor.AuthenticatedMemberId.vouchedFor(adminId)),
				Effect.provide(TestClock.layer()),
			),
		);

		expect(outcome).toEqual({ kind: "failed", at: undefined, failure: "expired" });
		expect(await listedIn(fixture)).toEqual([]);
	});

	it("says the member declined, for the bot the step was for", async () => {
		const { workspaceId, projectId, adminId } = await workspaceWithProject("Declined");
		const form = await as(adminId).start({ projectId, organization: undefined });

		const outcome = await as(adminId).made({ code: undefined, state: stateIn(form.url) });

		expect(outcome).toEqual({
			kind: "failed",
			at: { workspaceId, projectId },
			failure: "cancelled",
		});
	});

	it("makes an app without a webhook when GitHub couldn't reach this installation", async () => {
		const [local] = await servedAt("http://sugabots.localhost:3000");
		const { projectId, adminId } = await workspaceWithProject("Local");

		const form = await onPostgresAs(adminId)(local).start({ projectId, organization: undefined });

		const manifest = JSON.parse(form.manifest);
		expect(manifest).not.toHaveProperty("hook_attributes");
		expect(manifest.default_events).toEqual([]);
	});
});
