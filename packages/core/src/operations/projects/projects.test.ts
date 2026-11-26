import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedBot, seedProject, unique } from "../../authentication/seed.test-support.ts";
import { workspace } from "../../database/schema.ts";
import { closeDatabase, onDatabase } from "../../database/testing.ts";
import {
	authenticators,
	buildWorld,
	everyKindOfPrincipal,
	principals,
	type World,
} from "../../proofs/world.test-support.ts";
import { type CallOperation, operationOutcome, servedOperations } from "../testing.ts";

/**
 * What the projects operations prove beyond the rule `permissions.test.ts`
 * states for each: the workspace a slug names, what a run is shown it may do,
 * that a bot's default project has no settings of its own, and that a bot an
 * operation names besides the project must be one the member reaches.
 *
 * The world is `buildWorld`'s: in workspace A, Ed (an editor) made the public
 * bot Pub, which leads the private project J with Helper in it, and his
 * personal bot Personal; Erin (an editor) made her own.
 */
describe("the projects operations, beyond who may call them", () => {
	let call: CallOperation;
	let a: World["a"];
	let who: Awaited<ReturnType<typeof everyKindOfPrincipal>>;

	beforeAll(async () => {
		const world = await buildWorld();
		a = world.a;
		call = await servedOperations();
		who = await everyKindOfPrincipal(world, principals(await authenticators()));
	});

	afterAll(async () => {
		await closeDatabase();
	});

	it("takes the workspace by its slug, and hides a slug no workspace has", async () => {
		const [found] = await onDatabase((db) =>
			db.select({ slug: workspace.slug }).from(workspace).where(eq(workspace.id, a.workspace)),
		);
		const listed = await call(who.ed, "projects.list", { workspace: found?.slug ?? "" });

		expect(listed.map(({ id }) => id)).toContain(a.project);
		expect(
			await operationOutcome(call, who.ed, "projects.list", { workspace: `nobody-${unique()}` }),
		).toBe("ResourceHidden");
	});

	it("shows a principal acting for no member each bot with nothing it may do", async () => {
		const bots = await call(who.run, "projects.listBots", { projectId: a.project });

		expect(bots.map(({ id }) => id).toSorted()).toEqual([a.pub.id, a.helper.id].toSorted());
		for (const shown of bots) {
			expect(shown.pinned).toBe(false);
			expect(shown.permissions.update).toBe(false);
		}
	});

	it("refuses a bot's default project, which takes its settings from its bot, even to the bot's managers", async () => {
		expect(
			await operationOutcome(call, who.admin, "projects.update", {
				projectId: a.pub.defaultProject,
				changes: { name: "Ours" },
			}),
		).toBe("ActionForbidden");
	});

	it("checks that the member named by a roster change can be added or removed", async () => {
		const roster = { projectId: a.project };
		await expect(
			call(who.ed, "projects.addMember", { ...roster, memberId: who.outsider.member }),
		).rejects.toMatchObject({ _tag: "NotInWorkspace" });
		await expect(
			call(who.ed, "projects.removeMember", { ...roster, memberId: a.admin }),
		).rejects.toMatchObject({ _tag: "AdministratorInEveryProject" });
		await expect(
			call(who.ed, "projects.removeMember", { ...roster, memberId: a.erin }),
		).rejects.toMatchObject({ _tag: "NotInProject" });
	});

	it("hides a bot the member can't reach, as a project's lead or a bot added to it, and refuses their own personal bot", async () => {
		const erinsPersonal = await seedBot(a.workspace, {
			createdById: a.erin,
			visibility: "personal",
		});
		const projectId = await seedProject(a.workspace, { leadBotId: a.pub.id, members: [a.ed] });
		const naming = (botId: string) =>
			Promise.all([
				operationOutcome(call, who.ed, "projects.create", {
					workspace: a.workspace,
					name: `Project ${unique()}`,
					leadBotId: botId,
				}),
				operationOutcome(call, who.admin, "projects.update", {
					projectId,
					changes: { leadBotId: botId },
				}),
				operationOutcome(call, who.ed, "projects.addBot", { projectId, botId }),
			]);

		expect({
			someoneElsesPersonalBot: await naming(erinsPersonal.id),
			ownPersonalBot: await naming(a.personal.id),
		}).toEqual({
			someoneElsesPersonalBot: ["ResourceHidden", "ResourceHidden", "ResourceHidden"],
			ownPersonalBot: ["BotNotPublic", "ResourceHidden", "BotNotPublic"],
		});
	});
});
