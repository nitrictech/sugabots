import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedBot, seedMember, unique } from "../../authentication/seed.test-support.ts";
import { bot, modelProvider, providerModel } from "../../database/schema.ts";
import { closeDatabase, onDatabase } from "../../database/testing.ts";
import type { Principal } from "../../principal.ts";
import {
	authenticators,
	buildWorld,
	everyKindOfPrincipal,
	outcomesFor,
	principals,
	type World,
} from "../../proofs/world.test-support.ts";
import { type CallOperation, operationOutcome, servedOperations } from "../testing.ts";

/** The model workspace A offers, which the bots these cases make run on. */
const OFFERED = "offered-model";

/**
 * The bots operations, each called for every kind of principal through the
 * registry, as an entrypoint calls them. What each comes to is "ok" or the
 * tag of its refusal: hidden where the principal doesn't see the bot or the
 * workspace, forbidden where it does but may not act. Who may do what in
 * detail is the provers' tests'; the bots' own rules are `workspaces/bots/`'.
 *
 * The world is `buildWorld`'s: in workspace A, Ed (an editor) made the public
 * bot Pub, which leads the private project J, and his personal bot Personal,
 * and has a Personal Assistant; Erin is an editor, Vi a viewer.
 */
describe("the bots operations, for each kind of principal", () => {
	let world: World;
	let call: CallOperation;
	let as: ReturnType<typeof principals>;
	let a: World["a"];
	let who: Awaited<ReturnType<typeof everyKindOfPrincipal>>;

	beforeAll(async () => {
		world = await buildWorld();
		a = world.a;
		call = await servedOperations();
		as = principals(await authenticators());
		who = await everyKindOfPrincipal(world, as);
		const [provider] = await onDatabase((db) =>
			db
				.insert(modelProvider)
				.values({
					workspaceId: a.workspace,
					name: "Models",
					baseUrl: "https://models.example/v1",
					apiFormat: "openai",
					active: true,
				})
				.returning(),
		);
		if (!provider) throw new Error("could not create the model provider");
		await onDatabase((db) =>
			db.insert(providerModel).values({
				workspaceId: a.workspace,
				providerId: provider.id,
				modelId: OFFERED,
				enabled: true,
				source: "manual",
			}),
		);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	/** A public bot Erin made, for a case to change or delete. */
	const erinsBot = () => seedBot(a.workspace, { createdById: a.erin });

	describe("reading the workspace's bots", () => {
		it("lists only the identity and restriction permissions of another member's personal bot", async () => {
			await onDatabase((db) =>
				db
					.update(bot)
					.set({
						instructions: "Private instructions",
						description: "Private description",
					})
					.where(eq(bot.id, a.personal.id)),
			);
			const list = (principal: Principal) =>
				call(principal, "bots.list", { workspace: a.workspace });
			const shown = (await list(who.admin)).find(({ id }) => id === a.personal.id);
			expect(shown).toMatchObject({
				id: a.personal.id,
				defaultProjectId: a.personal.defaultProject,
				permissions: { talk: false, delete: true, update: false },
			});
			expect(shown).not.toHaveProperty("instructions");
			expect(shown).not.toHaveProperty("description");
			expect(shown).not.toHaveProperty("model");
			expect((await list(who.ed)).find(({ id }) => id === a.personal.id)).toHaveProperty(
				"instructions",
				"Private instructions",
			);
		});
		it("lists its bots and system bots to its members, and to a bot only in member bounds", async () => {
			for (const name of ["bots.list", "systemBots.list"] as const) {
				expect({
					name,
					outcomes: await outcomesFor(
						{
							viewer: who.vi,
							outsider: who.outsider,
							botInChatBounds: who.pubForEd,
						},
						(principal) => operationOutcome(call, principal, name, { workspace: a.workspace }),
					),
				}).toEqual({
					name,
					outcomes: {
						viewer: "ok",
						outsider: "ResourceHidden",
						botInChatBounds: "ActionForbidden",
					},
				});
			}
		});
	});

	describe("bots.create", () => {
		it("lists the bot the member created", async () => {
			const workspace = a.workspace;
			const name = `Bot ${unique()}`;
			const created = await call(who.ed, "bots.create", { workspace, name, model: OFFERED });

			expect(await call(who.ed, "bots.list", { workspace })).toContainEqual(
				expect.objectContaining({ id: created.id, name, model: OFFERED }),
			);
		});

		it("makes a bot for a member who may, and a bot only in member bounds", async () => {
			const create = (principal: Principal) =>
				operationOutcome(call, principal, "bots.create", {
					workspace: a.workspace,
					name: `Bot ${unique()}`,
					model: OFFERED,
				});

			expect(
				await outcomesFor(
					{
						editor: who.ed,
						viewer: who.vi,
						outsider: who.outsider,
					},
					create,
				),
			).toEqual({
				editor: "ok",
				viewer: "ActionForbidden",
				outsider: "ResourceHidden",
			});
		});
	});

	describe("bots.update", () => {
		it("updates what a manager changes and lets a bot write its interview instructions", async () => {
			const botId = a.pub.id;
			const list = async () =>
				(await call(who.ed, "bots.list", { workspace: a.workspace })).find(
					({ id }) => id === botId,
				);
			const name = `Pub ${unique()}`;
			const rename = (principal: Principal, target: string) =>
				operationOutcome(call, principal, "bots.update", { botId: target, changes: { name } });

			expect(await rename(who.erin, botId)).toBe("ActionForbidden");
			expect(await rename(who.admin, a.personal.id)).toBe("ResourceHidden");
			expect(await rename(who.pubInOwnChats, botId)).toBe("ActionForbidden");
			await call(who.ed, "bots.update", { botId, changes: { name } });
			expect(await list()).toMatchObject({ name });

			const instructions = "Triage support requests.";
			await call(who.pubInOwnChats, "bots.update", { botId, changes: { instructions } });
			expect(await list()).toMatchObject({ instructions });
		});
	});

	describe("bots.remove", () => {
		it("deletes a personal bot for an admin who may only restrict it", async () => {
			const target = await seedBot(a.workspace, { createdById: a.ed, visibility: "personal" });
			expect(await operationOutcome(call, who.ed, "bots.remove", { botId: a.assistant.id })).toBe(
				"ActionForbidden",
			);
			expect(await operationOutcome(call, who.outsider, "bots.remove", { botId: target.id })).toBe(
				"ResourceHidden",
			);

			await call(who.admin, "bots.remove", { botId: target.id });

			const bots = await call(who.ed, "bots.list", { workspace: a.workspace });
			expect(bots.map(({ id }) => id)).not.toContain(target.id);
		});
	});

	describe("pinning a bot", () => {
		it("shows a bot pinned and then unpinned in the member’s bot list", async () => {
			const target = await erinsBot();
			const listed = async () =>
				(await call(who.ed, "bots.list", { workspace: a.workspace })).find(
					({ id }) => id === target.id,
				);

			await call(who.ed, "bots.pin", { botId: target.id });
			expect(await listed()).toMatchObject({ pinned: true });
			await call(who.ed, "bots.unpin", { botId: target.id });
			expect(await listed()).toMatchObject({ pinned: false });
		});

		it("requires a bot reaching a member's sidebar to have approval before pinning or unpinning", async () => {
			for (const name of ["bots.pin", "bots.unpin"] as const) {
				const input = { botId: a.pub.id };
				expect(await operationOutcome(call, who.edsAssistant, name, input), name).toBe(
					"ApprovalNeeded",
				);
				expect(await operationOutcome(call, who.run, name, input), name).toBe("ActionForbidden");
				expect(await operationOutcome(call, who.outsider, name, input), name).toBe(
					"ResourceHidden",
				);
			}
		});
	});

	describe("bots.ensureAssistant", () => {
		it("lists the Personal Assistant provisioned for the member", async () => {
			const workspace = a.workspace;
			const member = await as.member(await seedMember(workspace, "viewer"));
			const assistant = await call(member, "bots.ensureAssistant", { workspace, model: OFFERED });

			expect(await call(member, "bots.list", { workspace })).toContainEqual(
				expect.objectContaining({ id: assistant.id, assistant: true, model: OFFERED }),
			);
		});

		it("makes a member signed in their Personal Assistant, and nobody else one", async () => {
			expect(
				await outcomesFor(
					{
						viewer: who.vi,
						outsider: who.outsider,
						botInMemberBounds: who.edsAssistant,
					},
					(principal) =>
						operationOutcome(call, principal, "bots.ensureAssistant", { workspace: a.workspace }),
				),
			).toEqual({
				viewer: "ok",
				outsider: "ResourceHidden",
				botInMemberBounds: "ActionForbidden",
			});
		});
	});

	describe("systemBots.update", () => {
		it("lists the model chosen for Compaction", async () => {
			const workspace = a.workspace;
			const key = "compact";
			await onDatabase((db) => db.update(bot).set({ model: null }).where(eq(bot.id, a.system.id)));
			await call(who.admin, "systemBots.update", { workspace, key, model: OFFERED });

			expect(await call(who.admin, "systemBots.list", { workspace })).toContainEqual(
				expect.objectContaining({ key, model: OFFERED }),
			);
		});

		it("chooses a system bot's model for the workspace's owner and admins, and a bot only in member bounds", async () => {
			expect(
				await outcomesFor(
					{
						admin: who.admin,
						editor: who.ed,
						outsider: who.outsider,
					},
					(principal) =>
						operationOutcome(call, principal, "systemBots.update", {
							workspace: a.workspace,
							key: "compact",
							model: OFFERED,
						}),
				),
			).toEqual({
				admin: "ok",
				editor: "ActionForbidden",
				outsider: "ResourceHidden",
			});
		});
	});
});
