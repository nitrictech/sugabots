import { createHmac } from "node:crypto";
import type { InputOf } from "@sugabots/contracts/operations";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedAutomation, seedConnector } from "../../authentication/seed.test-support.ts";
import { automationTrigger, connector } from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	type Promised,
	runOnPostgres,
	servedOnPostgres,
} from "../../database/testing.ts";
import type { MemberSession, Principal } from "../../principal.ts";
import {
	type Authenticators,
	authenticators,
	buildWorld,
	everyKindOfPrincipal,
	outcomesFor,
	principals,
	type World,
} from "../../proofs/world.test-support.ts";
import { ConnectorStore } from "../../providers/connectors/connector-store.ts";
import { encryptAppCredential } from "../../providers/connectors/github/credential.ts";
import { createEgressUrlValidator, Egress, urlValidation } from "../../providers/network/egress.ts";
import { unimplemented } from "../../testing.ts";
import { type CallOperation, operationOutcome, servedOperations } from "../testing.ts";

/**
 * The connectors operations, each called for every kind of principal through
 * the registry, as an entrypoint calls them. What each comes to is "ok", the
 * tag of its refusal, or the tag of the error its service answers once the
 * proofs let it act: hidden where the principal doesn't reach the project,
 * forbidden where it does but may not read or manage its connectors. What
 * the services do with what they are given is `providers/connectors/`' to test.
 *
 * The world is `buildWorld`'s: in workspace A, Ed (an editor) made the public
 * bot Pub, which leads the private project J with Helper in it, and his
 * personal bot; Ed, Vi (a viewer) and Quinn are in J, and Erin (an editor)
 * isn't. Nothing here is sent anywhere but a port on this machine nobody listens on.
 */

/** An address on this machine where nothing answers, so a request to it fails at once. */
const NOWHERE = "http://127.0.0.1:9";

/** A connector id no project has. */
const NO_CONNECTOR = "0199a3a0-0000-7000-8000-00000000c0de";

/** Egress that lets connectors use addresses on this machine, and reaches only those. */
const localEgress = unimplemented(Egress.Service, {
	providers: { for: () => fetch },
	validateProviderUrl: urlValidation(createEgressUrlValidator({ allowPrivateNetwork: true })),
	oauth: fetch,
	webFetch: fetch,
});

describe("the connectors operations, for each kind of principal", () => {
	let world: World;
	let auth: Authenticators;
	let call: CallOperation;
	let as: ReturnType<typeof principals>;
	let a: World["a"];
	let store: Promised<ConnectorStore.Interface>;
	/** Every principal the cases call for, on J unless its name says otherwise. */
	let who: Awaited<ReturnType<typeof everyKindOfPrincipal>>;
	/** J's GitHub app, made but not installed. */
	let jsApp: string;

	const WEBHOOK_SECRET = "the-webhook-secret";

	/** A GitHub app of `projectId`, made but not installed, whose deliveries are signed with `WEBHOOK_SECRET`. */
	const gitHubAppOf = (projectId: string) =>
		seedConnector(a.workspace, projectId, {
			github: {
				appCredentialEncrypted: encryptAppCredential(auth.secrets, {
					privateKey: "key",
					webhookSecret: WEBHOOK_SECRET,
				}),
			},
		});

	beforeAll(async () => {
		world = await buildWorld();
		a = world.a;
		auth = await authenticators();
		call = await servedOperations({ egress: localEgress });
		as = principals(auth);
		store = await servedOnPostgres(ConnectorStore.Service, ConnectorStore.layer);
		who = await everyKindOfPrincipal(world, as);
		jsApp = await gitHubAppOf(a.project);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	describe("reading a project's connectors", () => {
		it("lists and shows them, and its GitHub app's repositories, to whoever reaches it but a webhook call or system work", async () => {
			const connectorId = await seedConnector(a.workspace, a.project);
			const reads = [
				["connectors.list", { projectId: a.project }],
				["connectors.get", { projectId: a.project, connectorId }],
				["gitHubConnectors.repositories", { projectId: a.project, connectorId: jsApp }],
			] as const;
			for (const [name, input] of reads) {
				const read = (principal: Principal) =>
					operationOutcome(
						call,
						principal,
						name as "connectors.get",
						input as InputOf<"connectors.get">,
					);
				expect({
					name,
					outcomes: await outcomesFor(
						{
							viewer: who.vi,
							notInProject: who.erin,
							webhook: who.webhook,
						},
						read,
					),
				}).toEqual({
					name,
					outcomes: {
						viewer: "ok",
						notInProject: "ResourceHidden",
						webhook: "ResourceHidden",
					},
				});
			}
		});
	});

	describe("managing a project's connectors", () => {
		const manages = [
			["connectors.update", { changes: { access: "off" } }, "ok"],
			["connectors.remove", {}, "ok"],
			["connectors.test", {}, "ok"],
			["connectors.startOAuth", {}, "ConnectorDoesNotUseOAuth"],
			["connectors.testUnsaved", { url: `${NOWHERE}/mcp` }, "ok"],
			["gitHubConnectors.start", { organization: undefined }, "ProjectHasGitHubConnector"],
			["gitHubConnectors.installUrl", {}, "NotGitHubConnector"],
			["gitHubConnectors.reachableRepositories", {}, "NotGitHubConnector"],
			["gitHubConnectors.addRepository", { repository: "acme/web" }, "NotGitHubConnector"],
			["gitHubConnectors.removeRepository", { repository: "acme/web" }, "NotGitHubConnector"],
		] as const;

		it("lets only J's owner and admins, or a bot acting for one, manage J's", async () => {
			for (const [name, input, acted] of manages) {
				const manage = async (principal: Principal) => {
					const connectorId = await seedConnector(a.workspace, a.project);
					try {
						if (name === "connectors.test") {
							await onDatabase((db) =>
								db
									.update(connector)
									.set({ url: `${NOWHERE}/mcp` })
									.where(eq(connector.id, connectorId)),
							);
						}
						return await operationOutcome(call, principal, name, {
							projectId: a.project,
							connectorId,
							...input,
						} as InputOf<typeof name>);
					} finally {
						await onDatabase((db) => db.delete(connector).where(eq(connector.id, connectorId)));
					}
				};
				const permitted = name === "connectors.startOAuth" ? who.admin : who.pubForAdmin;
				const forbidden = name === "connectors.startOAuth" ? who.pubForAdmin : who.ed;
				expect(await manage(permitted), name).toBe(acted);
				expect(await manage(forbidden), name).toBe("ActionForbidden");
				expect(await manage(who.erin), name).toBe("ResourceHidden");
			}
		});

		it("connects J to an HTTP endpoint for an admin, as added by them, and changes and removes it", async () => {
			const made = await call(who.admin, "connectors.create", {
				projectId: a.project,
				connector: { kind: "http", name: "Alerts", url: `${NOWHERE}/v2` },
			});
			const changed = await call(who.admin, "connectors.update", {
				projectId: a.project,
				connectorId: made.id,
				changes: { access: "off" },
			});
			await call(who.admin, "connectors.remove", { projectId: a.project, connectorId: made.id });

			expect(made).toMatchObject({
				kind: "http",
				status: "connected",
				connectedBy: { id: a.admin },
			});
			if (!("toolCounts" in changed)) throw new Error("Expected connector settings");
			expect(changed.toolCounts).toMatchObject({ allow: 0, ask: 0 });
			expect(
				await operationOutcome(call, who.admin, "connectors.get", {
					projectId: a.project,
					connectorId: made.id,
				}),
			).toBe("ResourceHidden");
		});

		it("hides missing connectors and connectors of another project from every connector operation", async () => {
			const elsewhere = await seedConnector(a.workspace, a.otherProject);
			for (const connectorId of [elsewhere, NO_CONNECTOR]) {
				expect(
					await operationOutcome(call, who.admin, "connectors.update", {
						projectId: a.personal.defaultProject,
						connectorId,
						changes: { enabled: false },
					}),
				).toBe("ResourceHidden");
				const address = { projectId: a.project, connectorId };
				for (const [name, input] of manages) {
					if (name === "connectors.testUnsaved" || name === "gitHubConnectors.start") continue;
					expect(
						await operationOutcome(call, who.admin, name, { ...address, ...input } as InputOf<
							typeof name
						>),
					).toBe("ResourceHidden");
				}
				expect(await operationOutcome(call, who.admin, "connectors.get", address)).toBe(
					"ResourceHidden",
				);
				expect(
					await operationOutcome(call, who.admin, "gitHubConnectors.repositories", address),
				).toBe("ResourceHidden");
			}
		});
	});

	it("lists a public bot's connector for its viewer and restricts changes to its managers", async () => {
		const projectId = a.pub.defaultProject;
		const connectorId = await seedConnector(a.workspace, projectId);
		const input = { projectId, connectorId, changes: { name: "Project wiki" } };
		expect(await call(who.vi, "connectors.list", { projectId })).toContainEqual(
			expect.objectContaining({ id: connectorId }),
		);
		await expect(call(who.vi, "connectors.update", input)).rejects.toMatchObject({
			_tag: "ActionForbidden",
		});
		await expect(call(who.outsider, "connectors.update", input)).rejects.toMatchObject({
			_tag: "ResourceHidden",
		});

		await call(who.ed, "connectors.update", input);

		expect(await call(who.vi, "connectors.get", { projectId, connectorId })).toMatchObject({
			id: connectorId,
			name: input.changes.name,
		});
	});

	it("lets an admin switch off a hidden personal bot's connector without reading or changing its settings", async () => {
		const projectId = a.personal.defaultProject;
		const made = await store.create(a.workspace, projectId, a.ed, {
			name: "Personal connector",
			url: `${NOWHERE}/mcp`,
			auth: "oauth",
		});
		const address = { projectId, connectorId: made.id };
		const restricted = { id: made.id, name: made.name, enabled: true, restricted: true };
		expect(await call(who.admin, "connectors.list", { projectId })).toEqual([restricted]);
		expect(await operationOutcome(call, who.admin, "connectors.get", address)).toBe(
			"ResourceHidden",
		);
		for (const changes of [
			{ enabled: true },
			{ enabled: false, name: "Changed" },
			{ access: "off" as const },
		]) {
			expect(
				await operationOutcome(call, who.admin, "connectors.update", { ...address, changes }),
			).toBe("ResourceHidden");
		}
		expect(
			await operationOutcome(call, who.admin, "connectors.update", {
				...address,
				connectorId: NO_CONNECTOR,
				changes: { enabled: false },
			}),
		).toBe("ResourceHidden");
		expect(
			await call(who.admin, "connectors.update", { ...address, changes: { enabled: false } }),
		).toEqual({ ...restricted, enabled: false });
		expect((await store.targetsForProject(a.workspace, projectId)).targets).toEqual([]);
		expect(await call(who.ed, "connectors.get", address)).toMatchObject({
			name: made.name,
			url: made.url,
			enabled: false,
		});
		expect(
			await call(who.ed, "connectors.update", { ...address, changes: { enabled: true } }),
		).toMatchObject({ enabled: true });
	});

	describe("connectors.oauthCallback", () => {
		const signInStartedBy = async (session: MemberSession) => {
			const made = await store.create(a.workspace, a.project, session.member, {
				name: `Signs in ${crypto.randomUUID().slice(0, 8)}`,
				url: `${NOWHERE}/mcp`,
				auth: "oauth",
			});
			const state = crypto.randomUUID();
			await store.saveOauthRecord(
				a.workspace,
				made.id,
				{
					state,
					startedByMemberId: session.member,
					startedBySessionId: session.session,
				},
				{ kind: "since", version: null },
			);
			return state;
		};
		const back = (principal: Principal, input: InputOf<"connectors.oauthCallback">) =>
			call(principal, "connectors.oauthCallback", input);

		it("answers a callback with no state, or one no sign-in waits on, with only a code", async () => {
			expect(await back(who.admin, { code: "c" })).toEqual({
				kind: "failed",
				failure: "unknown_state",
				at: undefined,
			});
			expect(await back(who.admin, { code: "c", state: "nobody" })).toEqual({
				kind: "failed",
				failure: "unknown_state",
				at: undefined,
			});
		});

		it("finishes only in the session that started it, while they manage the project", async () => {
			const admins = await signInStartedBy(who.admin);
			const secondSession = await principals(auth).member(a.admin);
			const eds = await signInStartedBy(who.ed);
			const unknownState = { kind: "failed", failure: "unknown_state", at: undefined };

			expect(await back(who.owner, { code: "c", state: admins })).toEqual(unknownState);
			expect(await back(secondSession, { code: "c", state: admins })).toEqual(unknownState);
			expect(await back(who.ed, { code: "c", state: eds })).toEqual(unknownState);
			expect(await back(who.outsider, { code: "c", state: admins })).toEqual(unknownState);
			expect(await back(who.admin, { error: "access_denied", state: admins })).toEqual({
				kind: "failed",
				failure: "refused",
				at: { workspaceId: a.workspace, projectId: a.project },
			});
		});
	});

	describe("gitHubWebhooks.delivery", () => {
		const body = JSON.stringify({
			action: "opened",
			repository: { full_name: "acme/web" },
			sender: { login: "octocat" },
			issue: {
				number: 3,
				title: "Login",
				html_url: "https://github.com/acme/web/issues/3",
				body: null,
			},
		});
		const signedFor = (connectorId: string) =>
			auth.webhook.github(connectorId, {
				headers: {
					"x-hub-signature-256": `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`,
				},
				body,
			});

		it("starts the matching automation when its operation accepts a signed delivery", async () => {
			const projectId = a.pub.defaultProject;
			const connectorId = await gitHubAppOf(projectId);
			const automationId = await seedAutomation(a.workspace, projectId);
			await onDatabase((db) =>
				db
					.update(connector)
					.set({
						settings: sql`${connector.settings} || '{"repositories": [{"id": 1, "path": "acme/web"}]}'::jsonb`,
					})
					.where(eq(connector.id, connectorId)),
			);
			await onDatabase((db) =>
				db.insert(automationTrigger).values({
					workspaceId: a.workspace,
					automationId,
					settings: {
						kind: "github",
						connectorId,
						repository: "acme/web",
						events: ["issue_opened"],
					},
				}),
			);

			await call(who.admin, "chats.openAutomationFeed", { workspace: a.workspace, automationId });
			await call(await runOnPostgres(signedFor(connectorId)), "gitHubWebhooks.delivery", {
				connectorId,
				event: "issues",
				deliveryId: "review-delivery",
				body,
			});
			const { items } = await call(who.admin, "automations.projectRuns", { projectId, limit: 10 });
			expect(items.filter((run) => run.automationId === automationId)).toEqual([
				expect.objectContaining({ trigger: expect.objectContaining({ kind: "github" }) }),
			]);
		});

		it("reads a delivery only for the GitHub app that signed it", async () => {
			const ksApp = await gitHubAppOf(a.otherProject);
			const jsDelivery = await runOnPostgres(signedFor(jsApp));
			const ksDelivery = await runOnPostgres(signedFor(ksApp));
			const deliver = (principal: Principal) =>
				operationOutcome(call, principal, "gitHubWebhooks.delivery", {
					connectorId: jsApp,
					event: "issues",
					deliveryId: "delivery-1",
					body,
				});

			expect(
				await outcomesFor(
					{
						signedByIt: jsDelivery,
						signedByAnotherApp: ksDelivery,
						trigger: who.webhook,
						admin: who.admin,
						run: who.run,
					},
					deliver,
				),
			).toEqual({
				signedByIt: "ok",
				signedByAnotherApp: "ResourceHidden",
				trigger: "ResourceHidden",
				admin: "ResourceHidden",
				run: "ResourceHidden",
			});
			expect(
				await operationOutcome(call, jsDelivery, "automations.projectRuns", {
					projectId: a.project,
					limit: 10,
				}),
			).toBe("ResourceHidden");
			expect(
				await operationOutcome(call, jsDelivery, "chats.messages", { chatId: a.chat, limit: 10 }),
			).toBe("ResourceHidden");

			expect(
				await call(jsDelivery, "gitHubWebhooks.delivery", {
					connectorId: jsApp,
					event: "issues",
					deliveryId: "delivery-1",
					body,
				}),
			).toMatchObject({
				workspaceId: a.workspace,
				deliveryId: "delivery-1",
				activity: { event: "issue_opened", repository: "acme/web", number: 3 },
			});
		});
	});
});
