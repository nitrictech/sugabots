import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedBot, seedMember, unique } from "../../authentication/seed.test-support.ts";
import { query } from "../../database/database.ts";
import { bot, membership, modelProvider, project, providerModel } from "../../database/schema.ts";
import { closeDatabase, holdTransaction, onDatabase } from "../../database/testing.ts";
import type { Principal } from "../../principal.ts";
import {
	authenticators,
	buildWorld,
	everyKindOfPrincipal,
	principals,
	type World,
} from "../../proofs/world.test-support.ts";
import { type CallOperation, operationOutcome, servedOperations } from "../testing.ts";

/** The model workspace A offers, which the bots these cases make run on. */
const OFFERED = "offered-model";

/**
 * What the bots operations do beyond the rule `permissions.test.ts` states
 * for each: what an admin is shown of a personal bot they may only restrict,
 * what a bot may change of itself, and a member's Personal Assistants, made
 * and deleted whatever their role, even as they leave.
 *
 * The world is `buildWorld`'s: in workspace A, Ed (an editor) made the public
 * bot Pub and his personal bot Personal, and has a Personal Assistant.
 */
describe("the bots operations, beyond who may call them", () => {
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
		const list = (principal: Principal) => call(principal, "bots.list", { workspace: a.workspace });
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

	it("lets a bot change its own instructions in its own chats, and nothing else of itself", async () => {
		const botId = a.pub.id;
		const instructions = "Triage support requests.";

		expect(
			await operationOutcome(call, who.pubInOwnChats, "bots.update", {
				botId,
				changes: { name: `Pub ${unique()}` },
			}),
		).toBe("ActionForbidden");
		await call(who.pubInOwnChats, "bots.update", { botId, changes: { instructions } });
		expect(
			(await call(who.ed, "bots.list", { workspace: a.workspace })).find(({ id }) => id === botId),
		).toMatchObject({ instructions });
	});

	it("hides removal of any personal bot from unrelated editors and outsiders", async () => {
		for (const { id } of [a.personal, a.assistant]) {
			for (const caller of [who.erin, who.outsider]) {
				await expect(call(caller, "bots.remove", { botId: id })).rejects.toMatchObject({
					_tag: "ResourceHidden",
					resource: "bot",
				});
			}
		}
	});

	it("refuses settings changes once deletion starts and lets the creator finish deletion", async () => {
		const deleting = await seedBot(a.workspace, { createdById: a.ed });
		await onDatabase((db) =>
			db.update(project).set({ deleting: true }).where(eq(project.id, deleting.defaultProject)),
		);

		for (const changes of [{ name: "Renamed" }, { visibility: "private" as const }]) {
			expect(
				await operationOutcome(call, who.ed, "bots.update", { botId: deleting.id, changes }),
			).toBe("ResourceHidden");
		}
		await call(who.ed, "bots.remove", { botId: deleting.id });
		expect(await onDatabase((db) => db.select().from(bot).where(eq(bot.id, deleting.id)))).toEqual(
			[],
		);
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
});
