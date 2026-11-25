import { createHmac } from "node:crypto";
import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "@sugabots/contracts/operations/web";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedComputer, seedConnector } from "../authentication/seed.test-support.ts";
import { bot, searchProvider } from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import type { Principal } from "../principal.ts";
import { encryptAppCredential } from "../providers/connectors/github/credential.ts";
import { SearchProviderStore } from "../providers/search-providers/search-provider-store.ts";
import { type ComputerUse, proveCanUseComputer } from "./can-use-computer.ts";
import { proveCanUseConnector } from "./can-use-connector.ts";
import { proveCanUseWeb } from "./can-use-web.ts";
import { named } from "./proof.ts";
import {
	type Authenticators,
	authenticators,
	buildWorld,
	outcome,
	principals,
	type World,
} from "./world.test-support.ts";

describe("connectors and computers", () => {
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

		it("lets a run use its project's connectors and its bot's own, and members those they reach", async () => {
			const { a, b } = world;
			const projects = await seedConnector(a.workspace, a.project, { tools });
			const pubsOwn = await seedConnector(a.workspace, a.pub.defaultProject, { tools });
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

	describe("CanUseComputer", () => {
		/** The online computers of J and of K, one each, as a project has at most one. */
		let projectsComputer: string;
		let othersComputer: string;

		beforeAll(async () => {
			projectsComputer = await seedComputer(world.a.workspace, world.a.project);
			othersComputer = await seedComputer(world.a.workspace, world.a.otherProject);
		});

		const usesComputer = (principal: Principal, computerId: string, use: ComputerUse = "control") =>
			outcome(
				named(principal, computerId, (p, m) => proveCanUseComputer(p, m, use).pipe(Effect.asVoid)),
			);
		const setComputerUse = (botId: string, usesComputer: boolean) =>
			onDatabase((db) => db.update(bot).set({ usesComputer }).where(eq(bot.id, botId)));

		it("lets members watch a computer they reach, and take it over only with permission to", async () => {
			const { a } = world;
			expect(await usesComputer(await as.member(a.ed), projectsComputer, "watch")).toBe("ok");
			expect(await usesComputer(await as.member(a.ed), projectsComputer, "control")).toBe("ok");
			expect(await usesComputer(await as.member(a.vi), projectsComputer, "watch")).toBe("ok");
			expect(await usesComputer(await as.member(a.vi), projectsComputer, "control")).toBe(
				"ActionForbidden",
			);
			expect(await usesComputer(await as.member(a.erin), projectsComputer, "watch")).toBe(
				"ResourceHidden",
			);
		});

		it("lets a bot work on its bounds' computer only with its computer use on, for an asker who may change things", async () => {
			const { a } = world;
			const edsBot = await as.botFor(a.ed, a.pub.id, a.chat);
			const visBot = await as.botFor(a.vi, a.pub.id, a.chat);
			const { principal: run } = await as.run(a.workspace, a.project, a.pub.id);

			expect(await usesComputer(edsBot, projectsComputer)).toBe("ActionForbidden");
			await setComputerUse(a.pub.id, true);
			expect(await usesComputer(edsBot, projectsComputer)).toBe("ok");
			expect(await usesComputer(edsBot, othersComputer)).toBe("ResourceHidden");
			expect(await usesComputer(visBot, projectsComputer)).toBe("ActionForbidden");
			expect(await usesComputer(run, projectsComputer)).toBe("ok");
			await setComputerUse(a.pub.id, false);
			expect(await usesComputer(run, projectsComputer)).toBe("ActionForbidden");
		});

		it("hides computers from system work and webhook calls", async () => {
			const { a } = world;
			const sleep = await runOnPostgres(auth.systemWork.computerSleep(projectsComputer));
			expect(await usesComputer(sleep, projectsComputer)).toBe("ResourceHidden");
			expect(await usesComputer(sleep, projectsComputer, "watch")).toBe("ResourceHidden");
			expect(await usesComputer(sleep, othersComputer)).toBe("ResourceHidden");
			expect(await usesComputer(await as.webhook(a.workspace, a.project), projectsComputer)).toBe(
				"ResourceHidden",
			);
		});
	});
});
