import { createHmac } from "node:crypto";
import type { InputOf, OperationName } from "@sugabots/contracts/operations";
import { Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedConnector, seedMember } from "../../authentication/seed.test-support.ts";
import {
	closeDatabase,
	type Promised,
	runOnPostgres,
	servedOnPostgres,
} from "../../database/testing.ts";
import type { Principal } from "../../principal.ts";
import {
	type Authenticators,
	authenticators,
	buildWorld,
	principals,
	type World,
} from "../../proofs/world.test-support.ts";
import { ConnectorStore } from "../../providers/connectors/connector-store.ts";
import { encryptAppCredential } from "../../providers/connectors/github/credential.ts";
import { createEgressUrlValidator, Egress, urlValidation } from "../../providers/network/egress.ts";
import { type CallOperation, servedOperations } from "../testing.ts";

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
const localEgress = Layer.succeed(Egress.Service, {
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
	let who: Awaited<ReturnType<typeof principalsOnJ>>;
	/** J's GitHub app, made but not installed. */
	let jsApp: string;

	const WEBHOOK_SECRET = "the-webhook-secret";

	const principalsOnJ = async () => {
		const outsider = await seedMember(world.b.workspace, "editor");
		return {
			owner: await as.member(a.owner),
			admin: await as.member(a.admin),
			ed: await as.member(a.ed),
			vi: await as.member(a.vi),
			erin: await as.member(a.erin),
			viewerCreator: await as.member(a.viewerCreator),
			outsider: await as.member(outsider),
			/** Pub answering Ed in J's chat: chat bounds, J. */
			pubForEd: await as.botFor(a.ed, a.pub.id, a.chat),
			/** Pub answering an admin in J's chat: chat bounds, J. */
			pubForAdmin: await as.botFor(a.admin, a.pub.id, a.chat),
			/** Helper answering Ed in K's chat: chat bounds, K, though both reach J. */
			helperInK: await as.botFor(a.ed, a.helper.id, a.otherChat),
			/** Ed's Personal Assistant in its own chat: member bounds. */
			edsAssistant: await as.botFor(a.ed, a.assistant.id, a.assistantChat),
			run: (await as.run(a.workspace, a.project, a.pub.id)).principal,
			webhook: await as.webhook(a.workspace, a.project),
			computerSleep: (await as.computerSleep(a.workspace, a.project)).principal,
			compaction: await as.compaction(a.chat, a.pub.id),
			page: await as.page(a.chat),
		};
	};

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
		who = await principalsOnJ();
		jsApp = await gitHubAppOf(a.project);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	/** What calling `name` with `input` for `principal` came to: "ok", or its error's tag. */
	const tried = <Name extends OperationName>(
		principal: Principal,
		name: Name,
		input: InputOf<Name>,
	): Promise<string> =>
		call(principal, name, input).then(
			() => "ok",
			(failure: { readonly _tag: string }) => failure._tag,
		);

	/** What `attempt` came to for each principal of `principals`, by its name. */
	const outcomes = async <Key extends string>(
		principals: Record<Key, Principal>,
		attempt: (principal: Principal) => Promise<string>,
	) => {
		const entries = await Promise.all(
			Object.entries<Principal>(principals).map(async ([key, principal]) => [
				key,
				await attempt(principal),
			]),
		);
		return Object.fromEntries(entries) as Record<Key, string>;
	};

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
					tried(principal, name as "connectors.get", input as InputOf<"connectors.get">);
				expect({
					name,
					outcomes: await outcomes(
						{
							admin: who.admin,
							viewer: who.vi,
							notInProject: who.erin,
							outsider: who.outsider,
							botInBounds: who.pubForEd,
							botOutsideBounds: who.helperInK,
							botInMemberBounds: who.edsAssistant,
							run: who.run,
							webhook: who.webhook,
							computerSleep: who.computerSleep,
							compaction: who.compaction,
							page: who.page,
						},
						read,
					),
				}).toEqual({
					name,
					outcomes: {
						admin: "ok",
						viewer: "ok",
						notInProject: "ResourceHidden",
						outsider: "ResourceHidden",
						botInBounds: "ok",
						botOutsideBounds: "ResourceHidden",
						botInMemberBounds: "ok",
						run: "ok",
						webhook: "ActionForbidden",
						computerSleep: "ActionForbidden",
						compaction: "ResourceHidden",
						page: "ResourceHidden",
					},
				});
			}
		});
	});

	describe("managing a project's connectors", () => {
		/**
		 * Each operation that manages a project's connectors, on J, and what it
		 * comes to once the proofs let it act: no connector or GitHub app has
		 * the id it names, nothing answers at the address it is given, and J
		 * has its GitHub app already.
		 */
		const manages = () =>
			[
				[
					"connectors.update",
					{ connectorId: NO_CONNECTOR, changes: { name: "Renamed" } },
					"ConnectorNotFound",
				],
				["connectors.remove", { connectorId: NO_CONNECTOR }, "ConnectorNotFound"],
				["connectors.test", { connectorId: NO_CONNECTOR }, "ConnectorNotFound"],
				["connectors.startOAuth", { connectorId: NO_CONNECTOR }, "ConnectorNotFound"],
				["connectors.testUnsaved", { url: `${NOWHERE}/mcp` }, "ok"],
				["gitHubConnectors.start", { organization: undefined }, "ProjectHasGitHubConnector"],
				["gitHubConnectors.installUrl", { connectorId: NO_CONNECTOR }, "NotGitHubConnector"],
				[
					"gitHubConnectors.reachableRepositories",
					{ connectorId: NO_CONNECTOR },
					"NotGitHubConnector",
				],
				[
					"gitHubConnectors.addRepository",
					{ connectorId: NO_CONNECTOR, repository: "acme/web" },
					"NotGitHubConnector",
				],
				[
					"gitHubConnectors.removeRepository",
					{ connectorId: NO_CONNECTOR, repository: "acme/web" },
					"NotGitHubConnector",
				],
			] as const;

		it("lets only J's owner and admins, or a bot acting for one, manage J's", async () => {
			for (const [name, input, acted] of manages()) {
				const manage = (principal: Principal) =>
					tried(
						principal,
						name as "connectors.remove",
						{
							projectId: a.project,
							...input,
						} as InputOf<"connectors.remove">,
					);
				expect({
					name,
					outcomes: await outcomes(
						{
							owner: who.owner,
							admin: who.admin,
							editor: who.ed,
							viewer: who.vi,
							notInProject: who.erin,
							outsider: who.outsider,
							botForEditor: who.pubForEd,
							botForAdmin: who.pubForAdmin,
							botOutsideBounds: who.helperInK,
							run: who.run,
							webhook: who.webhook,
							computerSleep: who.computerSleep,
							page: who.page,
						},
						manage,
					),
				}).toEqual({
					name,
					outcomes: {
						owner: acted,
						admin: acted,
						editor: "ActionForbidden",
						viewer: "ActionForbidden",
						notInProject: "ResourceHidden",
						outsider: "ResourceHidden",
						botForEditor: "ActionForbidden",
						botForAdmin: acted,
						botOutsideBounds: "ResourceHidden",
						run: "ActionForbidden",
						webhook: "ActionForbidden",
						computerSleep: "ActionForbidden",
						page: "ResourceHidden",
					},
				});
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
			expect(changed.toolCounts).toMatchObject({ allow: 0, ask: 0 });
			expect(
				await tried(who.admin, "connectors.get", { projectId: a.project, connectorId: made.id }),
			).toBe("ConnectorNotFound");
		});

		it("refuses a connector of another project, though the principal manages both", async () => {
			const inK = await seedConnector(a.workspace, a.otherProject);

			expect(
				await tried(who.admin, "connectors.remove", { projectId: a.project, connectorId: inK }),
			).toBe("ConnectorNotFound");
		});
	});

	describe("a bot's own connectors", () => {
		it("are read by whoever reaches the bot, and managed by its managers; an admin doesn't reach a personal bot's", async () => {
			const cases = {
				publicBot: a.pub.defaultProject,
				personalBot: a.personal.defaultProject,
				viewerCreatorsBot: a.viewerCreatorsBot.defaultProject,
			};
			const results: Record<string, Record<string, string>> = {};
			for (const [bot, projectId] of Object.entries(cases)) {
				results[bot] = await outcomes(
					{ admin: who.admin, ed: who.ed, vi: who.vi, viewerCreator: who.viewerCreator },
					async (principal) => {
						const read = await tried(principal, "connectors.list", { projectId });
						const manage = await tried(principal, "connectors.remove", {
							projectId,
							connectorId: NO_CONNECTOR,
						});
						return `${read}/${manage}`;
					},
				);
			}

			expect(results).toEqual({
				publicBot: {
					admin: "ok/ConnectorNotFound",
					ed: "ok/ConnectorNotFound",
					vi: "ok/ActionForbidden",
					viewerCreator: "ok/ActionForbidden",
				},
				personalBot: {
					admin: "ResourceHidden/ResourceHidden",
					ed: "ok/ConnectorNotFound",
					vi: "ResourceHidden/ResourceHidden",
					viewerCreator: "ResourceHidden/ResourceHidden",
				},
				viewerCreatorsBot: {
					admin: "ok/ConnectorNotFound",
					ed: "ok/ActionForbidden",
					vi: "ok/ActionForbidden",
					viewerCreator: "ok/ActionForbidden",
				},
			});
		});
	});

	describe("connectors.oauthCallback", () => {
		/** An OAuth connector in J, waiting on the sign-in `startedByMemberId` started, and its state. */
		const signInStartedBy = async (startedByMemberId: string) => {
			const made = await store.create(a.workspace, a.project, startedByMemberId, {
				name: `Signs in ${crypto.randomUUID().slice(0, 8)}`,
				url: `${NOWHERE}/mcp`,
				auth: "oauth",
			});
			const state = crypto.randomUUID();
			await store.saveOauthRecord(a.workspace, made.id, { state, startedByMemberId });
			return state;
		};
		const back = (principal: Principal, input: InputOf<"connectors.oauthCallback">) =>
			call(principal, "connectors.oauthCallback", input);

		it("answers a callback with no state, or one no sign-in waits on, with only a code", async () => {
			expect(await back(who.admin, { code: "c" })).toEqual({
				kind: "failed",
				failure: "missing_state",
				at: undefined,
			});
			expect(await back(who.admin, { code: "c", state: "nobody" })).toEqual({
				kind: "failed",
				failure: "unknown_state",
				at: undefined,
			});
		});

		it("finishes only for the member who started it, while they manage the project", async () => {
			const admins = await signInStartedBy(a.admin);
			const eds = await signInStartedBy(a.ed);
			const notAllowed = { kind: "failed", failure: "not_allowed", at: undefined };

			expect(await back(who.owner, { code: "c", state: admins })).toEqual(notAllowed);
			expect(await back(who.ed, { code: "c", state: eds })).toEqual(notAllowed);
			expect(await back(who.outsider, { code: "c", state: admins })).toEqual(notAllowed);
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

		it("reads a delivery only for the GitHub app that signed it", async () => {
			const ksApp = await gitHubAppOf(a.otherProject);
			const jsDelivery = await runOnPostgres(signedFor(jsApp));
			const ksDelivery = await runOnPostgres(signedFor(ksApp));
			const deliver = (principal: Principal) =>
				tried(principal, "gitHubWebhooks.delivery", {
					connectorId: jsApp,
					event: "issues",
					deliveryId: "delivery-1",
					body,
				});

			expect(
				await outcomes(
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
