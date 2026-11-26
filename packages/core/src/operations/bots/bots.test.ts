import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedBot, seedMember, unique } from "../../authentication/seed.test-support.ts";
import { query } from "../../database/database.ts";
import { bot, membership, modelProvider, providerModel } from "../../database/schema.ts";
import { closeDatabase, holdTransaction, onDatabase } from "../../database/testing.ts";
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

	describe("whether a bot is personal", () => {
		it("never changes once the bot is made, whoever asks and whichever way", async () => {
			const publicBot = await seedBot(a.workspace, { createdById: a.ed });
			const personalBot = await seedBot(a.workspace, { createdById: a.ed, visibility: "personal" });
			const assistant = await seedBot(a.workspace, { assistantOf: a.ed, visibility: "personal" });
			const attempts = [
				["creator making their public bot personal", who.ed, publicBot, "personal"],
				["admin making a public bot personal", who.admin, publicBot, "personal"],
				["creator making their personal bot public", who.ed, personalBot, "public"],
				["creator making their Personal Assistant public", who.ed, assistant, "public"],
			] as const;
			for (const [attempt, principal, bot, visibility] of attempts) {
				expect(
					await operationOutcome(call, principal, "bots.update", {
						botId: bot.id,
						changes: { visibility },
					}),
					attempt,
				).toBe("PersonalVisibilityFixed");
			}

			const listed = await call(who.ed, "bots.list", { workspace: a.workspace });
			const visibilityOf = (bot: { readonly id: string }) =>
				listed.find(({ id }) => id === bot.id)?.visibility;
			expect([publicBot, personalBot, assistant].map(visibilityOf)).toEqual([
				"public",
				"personal",
				"personal",
			]);
		});
	});

	describe("bots.remove", () => {
		it("deletes a personal bot, a Personal Assistant included, for an admin who may only restrict it", async () => {
			const personalBot = await seedBot(a.workspace, { createdById: a.ed, visibility: "personal" });
			const assistant = await seedBot(a.workspace, { assistantOf: a.ed, visibility: "personal" });
			for (const target of [personalBot, assistant]) {
				expect(
					await operationOutcome(call, who.outsider, "bots.remove", { botId: target.id }),
				).toBe("ResourceHidden");
				expect(await operationOutcome(call, who.erin, "bots.remove", { botId: target.id })).toBe(
					"ResourceHidden",
				);
				await call(who.admin, "bots.remove", { botId: target.id });
			}

			const bots = await call(who.ed, "bots.list", { workspace: a.workspace });
			expect(bots.map(({ id }) => id)).not.toContain(personalBot.id);
			expect(bots.map(({ id }) => id)).not.toContain(assistant.id);
		});

		it("deletes a member's Personal Assistant for them, as a bot, leaving them in the workspace with their others", async () => {
			const assistant = await seedBot(a.workspace, { assistantOf: a.ed, visibility: "personal" });

			await call(who.ed, "bots.remove", { botId: assistant.id });

			const listed = (await call(who.ed, "bots.list", { workspace: a.workspace })).map(
				({ id }) => id,
			);
			expect(listed).not.toContain(assistant.id);
			expect(listed).toContain(a.assistant.id);
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

	describe("bots.createAssistant", () => {
		it("refuses a member whose departure commits while their Personal Assistant is being made", async () => {
			const memberId = await seedMember(a.workspace, "editor");
			const member = await as.member(memberId);
			const ofMember = and(
				eq(membership.workspaceId, a.workspace),
				eq(membership.memberId, memberId),
			);
			// A departure, holding the membership's row as one does, until it commits.
			const departure = holdTransaction(
				query((db) =>
					db.select({ id: membership.id }).from(membership).where(ofMember).for("update"),
				),
				query((db) => db.delete(membership).where(ofMember)),
			);
			await departure.held;

			const making = operationOutcome(call, member, "bots.createAssistant", {
				workspace: a.workspace,
			});
			await departure.waitForWaiters(1);
			await departure.release();

			expect(await making).toBe("ResourceHidden");
		});

		it("makes a member a Personal Assistant each time they ask, listed with their others", async () => {
			const workspace = a.workspace;
			const member = await as.member(await seedMember(workspace, "viewer"));
			const first = await call(member, "bots.createAssistant", { workspace });
			const another = await call(member, "bots.createAssistant", { workspace });

			const assistants = (await call(member, "bots.list", { workspace })).filter(
				(listed) => listed.assistant,
			);
			expect(assistants.map(({ id }) => id).sort()).toEqual([first.id, another.id].sort());
			expect(another).toMatchObject({ visibility: "personal", permissions: { talk: true } });
		});

		it("makes a Personal Assistant only for a member signed in, whatever their role", async () => {
			expect(
				await outcomesFor(
					{
						viewer: who.vi,
						outsider: who.outsider,
						botInMemberBounds: who.edsAssistant,
					},
					(principal) =>
						operationOutcome(call, principal, "bots.createAssistant", { workspace: a.workspace }),
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
