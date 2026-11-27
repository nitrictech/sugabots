import { createHmac } from "node:crypto";
import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "@sugabots/contracts/operations/web";
import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	addMembership,
	seedAutomation,
	seedBot,
	seedConnector,
	seedMessage,
	seedPage,
	seedProject,
	seedProjectBotConnector,
	seedProjectChat,
	seedWorkspace,
} from "../authentication/seed.test-support.ts";
import {
	bot,
	computerProvider,
	connector,
	file,
	modelProvider,
	providerModel,
	searchProvider,
} from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import type { Principal } from "../principal.ts";
import { encryptAppCredential } from "../providers/connectors/github/credential.ts";
import { SearchProviderStore } from "../providers/search-providers/search-provider-store.ts";
import { proveCanRestrictBotsProject } from "./can-restrict-bot.ts";
import { proveCanUseConnector } from "./can-use-connector.ts";
import { proveCanUseWeb } from "./can-use-web.ts";
import { proveInWorkspace } from "./in-workspace.ts";
import { type Named, named } from "./proof.ts";
import { proveReachesComputerProvider } from "./reaches-computer-provider.ts";
import { proveRestrictableConnector } from "./reaches-connector.ts";
import {
	proveReachesFileInChat,
	proveReachesMessageFile,
	proveReachesWrittenFile,
} from "./reaches-file.ts";
import { proveReachesModelProvider, proveReachesProviderModel } from "./reaches-model-provider.ts";
import { proveRestrictableAutomation } from "./reaches-project-automation.ts";
import { proveReachesSearchProvider } from "./reaches-search-provider.ts";
import { proveCanManageWorkspace } from "./workspace-permissions.ts";
import {
	type Authenticators,
	authenticators,
	buildWorld,
	outcome,
	principals,
	type World,
} from "./world.test-support.ts";

describe("resource proofs", () => {
	let world: World;
	let auth: Authenticators;
	let as: ReturnType<typeof principals>;

	beforeAll(async () => {
		world = await buildWorld();
		auth = await authenticators();
		as = principals(auth);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	const tools = [
		{ name: "list_issues", description: null, readOnly: true, destructive: null },
		{ name: "create_issue", description: null, readOnly: false, destructive: null },
	];

	it("limits file reach by chat, kind and whether an attachment was sent", async () => {
		const { a } = world;
		const member = await as.member(a.ed);
		const anotherChat = await seedProjectChat(a.workspace, a.project, a.ed);
		const page = await seedPage(a.chat);
		const message = await seedMessage(a.chat, { member: a.ed });
		const upload = {
			chatId: a.chat,
			kind: "attachment",
			name: "notes.txt",
			contentType: "text/plain",
			size: 5,
			uploaderId: a.ed,
		} as const;
		const attachments = await onDatabase((db) =>
			db
				.insert(file)
				.values([upload, { ...upload, messageId: message, position: 0 }])
				.returning({ id: file.id, message: file.messageId }),
		);
		const sent = attachments.find((attachment) => attachment.message === message);
		const unsent = attachments.find((attachment) => attachment.message === null);
		if (!sent || !unsent) throw new Error("Expected the sent and unsent attachments");
		const inChat = (chatId: string) =>
			outcome(
				named(member, chatId, page, (principal, chat, page) =>
					proveReachesFileInChat(principal, chat, page).pipe(Effect.asVoid),
				),
			);
		const written = (fileId: string) =>
			outcome(
				named(member, fileId, (principal, file) =>
					proveReachesWrittenFile(principal, file).pipe(Effect.asVoid),
				),
			);
		const onMessage = (fileId: string) =>
			outcome(
				named(member, a.chat, fileId, (principal, chat, file) =>
					proveReachesMessageFile(principal, chat, file).pipe(Effect.asVoid),
				),
			);

		expect({
			pageInItsChat: await inChat(a.chat),
			pageInAnotherChat: await inChat(anotherChat),
			writtenPage: await written(page),
			uploadedAttachment: await written(unsent.id),
			sentAttachment: await onMessage(sent.id),
			unsentAttachment: await onMessage(unsent.id),
		}).toEqual({
			pageInItsChat: "ok",
			pageInAnotherChat: "ResourceHidden",
			writtenPage: "ok",
			uploadedAttachment: "ResourceHidden",
			sentAttachment: "ok",
			unsentAttachment: "ResourceHidden",
		});
	});

	it("limits restriction to the resources of the bot's default project", async () => {
		const { a } = world;
		const admin = await as.member(a.admin);
		const own = a.personal.defaultProject;
		const ownConnector = await seedConnector(a.workspace, own);
		const otherConnector = await seedConnector(a.workspace, a.project);
		const ownAutomation = await seedAutomation(a.workspace, own);
		const otherAutomation = await seedAutomation(a.workspace, a.project);
		const connector = (id: string) =>
			outcome(
				named(admin, own, id, (principal, project, connector) =>
					proveCanRestrictBotsProject(principal, project).pipe(
						Effect.flatMap((restricts) => proveRestrictableConnector(restricts, connector)),
						Effect.asVoid,
					),
				),
			);
		const automation = (id: string) =>
			outcome(
				named(admin, own, id, (principal, project, automation) =>
					proveCanRestrictBotsProject(principal, project).pipe(
						Effect.flatMap((restricts) => proveRestrictableAutomation(restricts, automation)),
						Effect.asVoid,
					),
				),
			);

		expect({
			ownConnector: await connector(ownConnector),
			otherConnector: await connector(otherConnector),
			ownAutomation: await automation(ownAutomation),
			otherAutomation: await automation(otherAutomation),
		}).toEqual({
			ownConnector: "ok",
			otherConnector: "ResourceHidden",
			ownAutomation: "ok",
			otherAutomation: "ResourceHidden",
		});
	});

	const managesWorkspace = <P, W>(principal: Named<P, Principal>, workspace: Named<W, string>) =>
		proveInWorkspace(principal, workspace).pipe(Effect.flatMap(proveCanManageWorkspace));

	it("limits a workspace manager to that workspace's computer providers", async () => {
		const { a, b } = world;
		const admin = await as.member(a.admin);
		const providers = await onDatabase((db) =>
			db
				.insert(computerProvider)
				.values(
					[a.workspace, b.workspace].map((workspaceId) => ({
						workspaceId,
						settings: {
							builtIn: "opensandbox" as const,
							serverUrl: "http://computers.test",
							image: "debian",
						},
					})),
				)
				.returning({ id: computerProvider.id, workspace: computerProvider.workspaceId }),
		);
		const local = providers.find(({ workspace }) => workspace === a.workspace);
		const foreign = providers.find(({ workspace }) => workspace === b.workspace);
		if (!local || !foreign) throw new Error("Expected a provider in each workspace");
		const reaches = (id: string) =>
			outcome(
				named(admin, a.workspace, id, (principal, workspace, provider) =>
					managesWorkspace(principal, workspace).pipe(
						Effect.flatMap((canManage) => proveReachesComputerProvider(canManage, provider)),
						Effect.asVoid,
					),
				),
			);

		expect({ local: await reaches(local.id), foreign: await reaches(foreign.id) }).toEqual({
			local: "ok",
			foreign: "ResourceHidden",
		});
	});

	it("proves model providers in the workspace and their configured models with a credential", async () => {
		const { a, b } = world;
		const admin = await as.member(a.admin);
		const addProvider = async (workspaceId: string, name: string, apiKeyEncrypted?: string) => {
			const [provider] = await onDatabase((db) =>
				db
					.insert(modelProvider)
					.values({
						workspaceId,
						name,
						apiFormat: "openai",
						baseUrl: "https://models.example.com",
						apiKeyEncrypted,
					})
					.returning({ id: modelProvider.id }),
			);
			if (!provider) throw new Error("Expected a model provider");
			return provider.id;
		};
		const local = await addProvider(a.workspace, "Local models", auth.secrets.encrypt("model-key"));
		const noKey = await addProvider(a.workspace, "No key");
		const foreign = await addProvider(b.workspace, "Other models");
		const models = await onDatabase((db) =>
			db
				.insert(providerModel)
				.values([
					{ workspaceId: a.workspace, providerId: local, modelId: "local-model", source: "manual" },
					{ workspaceId: a.workspace, providerId: noKey, modelId: "unavailable", source: "manual" },
				])
				.returning({ id: providerModel.id, provider: providerModel.providerId }),
		);
		const configured = models.find(({ provider }) => provider === local);
		const unavailable = models.find(({ provider }) => provider === noKey);
		if (!configured || !unavailable) throw new Error("Expected a model for each local provider");
		const provider = (id: string) =>
			outcome(
				named(admin, a.workspace, id, (principal, workspace, provider) =>
					managesWorkspace(principal, workspace).pipe(
						Effect.flatMap((canManage) => proveReachesModelProvider(canManage, provider)),
						Effect.asVoid,
					),
				),
			);
		const model = (id: string, modelId: string) =>
			outcome(
				named(admin, a.workspace, id, modelId, (principal, workspace, provider, model) =>
					managesWorkspace(principal, workspace).pipe(
						Effect.flatMap((canManage) => proveReachesModelProvider(canManage, provider)),
						Effect.flatMap((reach) => proveReachesProviderModel(reach, model)),
						Effect.asVoid,
					),
				),
			);

		expect({
			localProvider: await provider(local),
			foreignProvider: await provider(foreign),
			configuredModel: await model(local, configured.id),
			unknownModel: await model(local, crypto.randomUUID()),
			providerWithoutKey: await model(noKey, unavailable.id),
		}).toEqual({
			localProvider: "ok",
			foreignProvider: "ModelProviderNotFound",
			configuredModel: "ok",
			unknownModel: "ProviderModelNotFound",
			providerWithoutKey: "ProviderModelsRequireCredential",
		});
	});

	it("hides other workspaces' search providers from a workspace's manager", async () => {
		const { a, b } = world;
		const admin = await as.member(a.ed);
		const workspaceWithoutProvider = await seedWorkspace();
		await addMembership(workspaceWithoutProvider, a.ed, "admin");
		await onDatabase((db) =>
			db.insert(searchProvider).values({
				workspaceId: b.workspace,
				builtIn: "brave",
				baseUrl: "https://search.example.com",
			}),
		);
		const provider = (workspaceId: string) =>
			outcome(
				named(admin, workspaceId, (principal, workspace) =>
					managesWorkspace(principal, workspace).pipe(
						Effect.flatMap(proveReachesSearchProvider),
						Effect.asVoid,
					),
				),
			);

		expect({
			withProvider: await provider(b.workspace),
			withoutProvider: await provider(workspaceWithoutProvider),
		}).toEqual({ withProvider: "ok", withoutProvider: "SearchProviderNotFound" });
	});

	describe("CanUseConnector", () => {
		const uses = (principal: Principal, connectorId: string, tool: string) =>
			outcome(
				named(principal, connectorId, (p, k) =>
					proveCanUseConnector(p, k, tool).pipe(Effect.asVoid),
				),
			);

		it("lets a bot use its chat's project's connectors and its own, writing only for an asker who may change things", async () => {
			const { a } = world;
			const projects = await seedConnector(a.workspace, a.project, { tools });
			const pubsOwn = await seedConnector(a.workspace, a.pub.defaultProject, { tools });
			const elsewhere = await seedConnector(a.workspace, a.otherProject, { tools });
			await seedProjectBotConnector(a.workspace, a.project, a.pub.id, pubsOwn);
			const edsBot = await as.botFor(a.ed, a.pub.id, a.chat);
			const visBot = await as.botFor(a.vi, a.pub.id, a.chat);
			const helpersTurn = await as.botFor(a.ed, a.helper.id, a.chat);

			expect(await uses(edsBot, projects, "create_issue")).toBe("ok");
			expect(await uses(edsBot, pubsOwn, "create_issue")).toBe("ok");
			expect(await uses(edsBot, elsewhere, "list_issues")).toBe("ResourceHidden");
			expect(await uses(visBot, projects, "list_issues")).toBe("ok");
			expect(await uses(visBot, projects, "create_issue")).toBe("ActionForbidden");
			expect(await uses(visBot, pubsOwn, "create_issue")).toBe("ActionForbidden");
			expect(await uses(visBot, projects, "a_tool_it_never_listed")).toBe("ActionForbidden");
			// Pub's own connectors are Pub's, not those of another bot in the chat.
			expect(await uses(helpersTurn, pubsOwn, "list_issues")).toBe("ResourceHidden");
		});

		it("keeps a bot's own connector off in another project until it is turned on there, for its address", async () => {
			const { a } = world;
			const pubsOwn = await seedConnector(a.workspace, a.pub.defaultProject, { tools });
			const inProject = await as.botFor(a.ed, a.pub.id, a.chat);
			const inOwnChat = await as.botFor(
				a.ed,
				a.pub.id,
				await seedProjectChat(a.workspace, a.pub.defaultProject, a.ed),
			);
			const { principal: run } = await as.run(a.workspace, a.project, a.pub.id);

			expect(await uses(inOwnChat, pubsOwn, "list_issues")).toBe("ok");
			expect(await uses(inProject, pubsOwn, "list_issues")).toBe("ResourceHidden");
			expect(await uses(run, pubsOwn, "list_issues")).toBe("ResourceHidden");

			await seedProjectBotConnector(a.workspace, a.project, a.pub.id, pubsOwn);
			expect(await uses(inProject, pubsOwn, "list_issues")).toBe("ok");
			expect(await uses(run, pubsOwn, "list_issues")).toBe("ok");

			// Sending its data somewhere else, which raises its address revision, turns it off again.
			await onDatabase((db) =>
				db
					.update(connector)
					.set({
						url: "https://elsewhere.example.com/mcp",
						addressRevision: sql`${connector.addressRevision} + 1`,
					})
					.where(eq(connector.id, pubsOwn)),
			);
			expect(await uses(inProject, pubsOwn, "list_issues")).toBe("ResourceHidden");
			expect(await uses(inOwnChat, pubsOwn, "list_issues")).toBe("ok");
		});

		it("lets a private bot use its own connector, turned on in a private project, for that project's members", async () => {
			const { a } = world;
			const privateBot = await seedBot(a.workspace, { createdById: a.ed, visibility: "private" });
			const project = await seedProject(a.workspace, {
				leadBotId: privateBot.id,
				members: [a.ed, a.quinn, a.vi],
			});
			const own = await seedConnector(a.workspace, privateBot.defaultProject, { tools });
			await seedProjectBotConnector(a.workspace, project, privateBot.id, own);
			const chat = await seedProjectChat(a.workspace, project, a.quinn);
			// Quinn and Vi are in the project but not the bot's members.
			const quinnsTurn = await as.botFor(a.quinn, privateBot.id, chat);
			const visTurn = await as.botFor(a.vi, privateBot.id, chat);

			expect(await uses(quinnsTurn, own, "list_issues")).toBe("ok");
			expect(await uses(quinnsTurn, own, "create_issue")).toBe("ok");
			expect(await uses(visTurn, own, "list_issues")).toBe("ok");
			expect(await uses(visTurn, own, "create_issue")).toBe("ActionForbidden");
		});

		it("lets a run use its project's connectors and its bot's own, and members those they reach", async () => {
			const { a, b } = world;
			const projects = await seedConnector(a.workspace, a.project, { tools });
			const pubsOwn = await seedConnector(a.workspace, a.pub.defaultProject, { tools });
			await seedProjectBotConnector(a.workspace, a.project, a.pub.id, pubsOwn);
			const { principal: run } = await as.run(a.workspace, a.project, a.pub.id);
			expect(await uses(run, projects, "create_issue")).toBe("ok");
			expect(await uses(run, pubsOwn, "create_issue")).toBe("ok");
			expect(await uses(await as.member(a.ed), projects, "create_issue")).toBe("ok");
			expect(await uses(await as.member(a.vi), projects, "create_issue")).toBe("ActionForbidden");
			expect(await uses(await as.member(a.erin), projects, "list_issues")).toBe("ResourceHidden");
			const bConnector = await seedConnector(b.workspace, b.project, { tools });
			expect(await uses(await as.botFor(a.ed, a.pub.id, a.chat), bConnector, "list_issues")).toBe(
				"ResourceHidden",
			);
		});

		it("lets a GitHub app's webhook call use only its own connector", async () => {
			const { a } = world;
			const secret = "github-secret";
			const app = await seedConnector(a.workspace, a.project, {
				github: {
					appCredentialEncrypted: encryptAppCredential(auth.secrets, {
						privateKey: "key",
						webhookSecret: secret,
					}),
				},
			});
			const other = await seedConnector(a.workspace, a.project, { tools });
			const body = "{}";
			const call = await runOnPostgres(
				auth.webhook.github(app, {
					headers: {
						"x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
					},
					body,
				}),
			);
			expect(await uses(call, app, "list_issues")).toBe("ok");
			expect(await uses(call, other, "list_issues")).toBe("ResourceHidden");
			expect(await uses(await as.webhook(a.workspace, a.project), other, "list_issues")).toBe(
				"ResourceHidden",
			);
		});

		it("carries the tool's access and whether it writes or deletes, as they stand", async () => {
			const { a } = world;
			const connectorId = await seedConnector(a.workspace, a.project, {
				tools,
				toolAccess: { create_issue: "off" },
			});
			const carried = await runOnPostgres(
				named(await as.member(a.ed), connectorId, (p, k) =>
					Effect.all([
						proveCanUseConnector(p, k, "create_issue"),
						proveCanUseConnector(p, k, "list_issues"),
					]).pipe(
						Effect.map((proofs) =>
							proofs.map(({ access, writeOrDelete }) => ({ access, writeOrDelete })),
						),
					),
				),
			);
			expect(carried).toEqual([
				{ access: "off", writeOrDelete: true },
				{ access: "allow", writeOrDelete: false },
			]);
		});
	});

	it("proves web access only with a workspace provider and a bot's tool switched on", async () => {
		const { a, b } = world;
		const principal = await as.botFor(a.ed, a.pub.id, a.chat);
		const uses = (workspaceId: string, tool: typeof WEB_FETCH_TOOL | typeof WEB_SEARCH_TOOL) =>
			outcome(
				named(principal, workspaceId, (principal, workspace) =>
					proveCanUseWeb(principal, workspace, tool).pipe(Effect.asVoid),
				).pipe(Effect.provide(SearchProviderStore.layer)),
			);

		expect(await uses(a.workspace, WEB_SEARCH_TOOL)).toBe("WebToolOff");
		const apiKeyEncrypted = auth.secrets.encrypt("test-search-key");
		await onDatabase((db) =>
			db.insert(searchProvider).values({
				workspaceId: a.workspace,
				builtIn: "brave",
				baseUrl: "https://search.example.com",
				enabled: true,
				apiKeyEncrypted,
			}),
		);
		expect(await uses(a.workspace, WEB_SEARCH_TOOL)).toBe("ok");
		await onDatabase((db) =>
			db
				.update(bot)
				.set({ disabledTools: [WEB_SEARCH_TOOL] })
				.where(eq(bot.id, a.pub.id)),
		);
		expect(await uses(a.workspace, WEB_SEARCH_TOOL)).toBe("WebToolOff");
		expect(await uses(a.workspace, WEB_FETCH_TOOL)).toBe("ok");
		expect(await uses(b.workspace, WEB_FETCH_TOOL)).toBe("ResourceHidden");
	});
});
