import { and, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ActionForbidden, ResourceHidden } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import { Computers } from "../../computers/computers.ts";
import { ProjectComputers } from "../../computers/project-computers.ts";
import {
	bot,
	membership,
	modelProvider,
	person,
	project,
	projectBot,
	providerModel,
	workspace,
	workspaceDefaultModel,
} from "../../database/schema.ts";
import {
	closeDatabase,
	holdTransaction,
	onDatabase,
	type Promised,
	runOnPostgres,
	servedOnPostgres,
	waitUntilWaitingOnLocks,
} from "../../database/testing.ts";
import { ModelProviderStore } from "../../providers/model-providers/model-provider-store.ts";
import { unimplemented } from "../../testing.ts";
import { LeadsProjects } from "../projects/project-leads.ts";
import { defaultProjectOf } from "../projects/project-reads.ts";
import { ProjectStore } from "../projects/project-store.ts";
import { seedProject } from "../projects/seed.test-support.ts";
import { servedOnPostgresAs } from "../testing.ts";
import { BotAdministration } from "./bot-administration.ts";
import { BotStore } from "./bot-store.ts";
import { PersonalAssistants } from "./personal-assistants.ts";

/** Bots run only on a model the workspace offers, which here is `OFFERED`. */
const OFFERED = "offered-model";
const ALSO_OFFERED = "also-offered-model";

describe.skipIf(!process.env.DATABASE_URL)("administering bots", () => {
	let bots: Promised<BotStore.Interface>;
	let assistants: Promised<PersonalAssistants.Interface>;
	let administrationAs: (personId: string) => Promised<BotAdministration.Interface>;
	/** The administration as the workspace's administrator. */
	let administration: Promised<BotAdministration.Interface>;
	let workspaceId: string;
	let creatorId: string;
	/** The projects whose computers were destroyed, in order. */
	let destroyedComputers: string[] = [];
	let providerReachable = true;

	beforeAll(async () => {
		bots = await servedOnPostgres(BotStore.Service, BotStore.layer);
		assistants = await servedOnPostgres(PersonalAssistants.Service, PersonalAssistants.layer);
		administrationAs = await servedOnPostgresAs(
			BotAdministration.Service,
			BotAdministration.layerNoDeps.pipe(
				Layer.provide([
					Authorization.layer,
					BotStore.layer,
					ModelProviderStore.layer,
					PersonalAssistants.layer,
					unimplemented(ProjectComputers.Service, {
						destroy: ({ projectId }) =>
							providerReachable
								? Effect.sync(() => {
										destroyedComputers.push(projectId);
									})
								: Effect.fail(
										new Computers.Unavailable({ provider: "opensandbox", cause: "unreachable" }),
									),
					}),
				]),
			),
		);
	});

	/** The bot `botId` as the workspace's bots list shows it to `as`. */
	const listedTo = async (as: Promised<BotAdministration.Interface>, botId: string) =>
		(await as.list({ workspace: workspaceId })).find((one) => one.id === botId);

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		destroyedComputers = [];
		providerReachable = true;
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: stamp, slug: `models-${stamp}` })
				.returning(),
		);
		const [somebody] = await onDatabase((db) =>
			db
				.insert(person)
				.values({ name: "Ada", email: `ada-${stamp}@example.com` })
				.returning(),
		);
		if (!space || !somebody) throw new Error("could not create the fixtures");
		workspaceId = space.id;
		creatorId = somebody.id;
		administration = administrationAs(creatorId);
		await onDatabase((db) =>
			db.insert(membership).values({ workspaceId, personId: creatorId, role: "admin" }),
		);
		const [provider] = await onDatabase((db) =>
			db
				.insert(modelProvider)
				.values({
					workspaceId,
					name: "Models",
					baseUrl: "https://models.example/v1",
					apiFormat: "openai",
					active: true,
				})
				.returning(),
		);
		if (!provider) throw new Error("could not create the fixtures");
		await onDatabase((db) =>
			db.insert(providerModel).values([
				{ workspaceId, providerId: provider.id, modelId: OFFERED, enabled: true, source: "manual" },
				{
					workspaceId,
					providerId: provider.id,
					modelId: ALSO_OFFERED,
					enabled: true,
					source: "manual",
				},
				{ workspaceId, providerId: provider.id, modelId: "switched-off", source: "manual" },
			]),
		);
	});

	it("creates a bot on a model the workspace offers", async () => {
		const made = await administration.create({
			workspace: workspaceId,
			bot: {
				name: "Triage",
				model: OFFERED,
			},
		});

		expect(made.model).toBe(OFFERED);
	});

	it("names who added a bot, and nobody once it has no creator", async () => {
		const made = await administration.create({
			workspace: workspaceId,
			bot: { name: "Triage", model: OFFERED },
		});
		const [creator] = await onDatabase((db) =>
			db.select().from(person).where(eq(person.id, creatorId)),
		);

		expect(made.createdBy).toEqual({
			id: creatorId,
			name: "Ada",
			email: creator?.email,
			image: null,
		});

		await onDatabase((db) => db.update(bot).set({ createdById: null }).where(eq(bot.id, made.id)));
		expect((await listedTo(administration, made.id))?.createdBy).toBeNull();
	});

	it("lists a bot with its default project", async () => {
		const made = await administration.create({
			workspace: workspaceId,
			bot: { name: "Triage", model: OFFERED },
		});
		const [own] = await onDatabase((db) =>
			db.select({ id: project.id }).from(project).where(eq(project.defaultOfBotId, made.id)),
		);

		expect(
			(await administration.list({ workspace: workspaceId })).find((one) => one.id === made.id)
				?.defaultProjectId,
		).toBe(own?.id);
	});

	it.each(["unknown-model", "switched-off"])(
		"refuses to create a bot on %s, and creates nothing",
		async (model) => {
			await expect(
				administration.create({ workspace: workspaceId, bot: { name: "Triage", model } }),
			).rejects.toBeInstanceOf(ModelProviderStore.ModelNotEnabled);

			expect(
				await onDatabase((db) => db.select().from(bot).where(eq(bot.workspaceId, workspaceId))),
			).toEqual([]);
		},
	);

	it("refuses to move a bot to a model the workspace does not offer, but lets it be cleared", async () => {
		const made = await administration.create({
			workspace: workspaceId,
			bot: {
				name: "Triage",
				model: OFFERED,
			},
		});

		await expect(
			administration.update({ botId: made.id, changes: { model: "switched-off" } }),
		).rejects.toBeInstanceOf(ModelProviderStore.ModelNotEnabled);
		expect(
			(await administration.update({ botId: made.id, changes: { model: null } })).model,
		).toBeNull();
	});

	it("refuses a change that changes nothing", async () => {
		const made = await administration.create({
			workspace: workspaceId,
			bot: {
				name: "Triage",
				model: OFFERED,
			},
		});

		await expect(administration.update({ botId: made.id, changes: {} })).rejects.toBeInstanceOf(
			BotAdministration.EmptyBotUpdate,
		);
	});

	it("sets a system bot up only on a model the workspace offers", async () => {
		await bots.ensureSystemBots({ workspaceId, createdById: creatorId });

		await expect(
			administration.setSystemBotModel({
				workspace: workspaceId,
				key: "compact",
				model: "unknown-model",
			}),
		).rejects.toBeInstanceOf(ModelProviderStore.ModelNotEnabled);
		expect(
			(
				await administration.setSystemBotModel({
					workspace: workspaceId,
					key: "compact",
					model: OFFERED,
				})
			).model,
		).toBe(OFFERED);
	});

	it("refuses what a viewer may not do, and hides a bot from somebody outside the workspace", async () => {
		const made = await administration.create({
			workspace: workspaceId,
			bot: { name: "Triage", model: OFFERED },
		});
		const [viewer, stranger] = await onDatabase((db) =>
			db
				.insert(person)
				.values([
					{ name: "Lee", email: `lee-${crypto.randomUUID()}@example.com` },
					{ name: "Kim", email: `kim-${crypto.randomUUID()}@example.com` },
				])
				.returning(),
		);
		if (!viewer || !stranger) throw new Error("could not create the people");
		await onDatabase((db) =>
			db.insert(membership).values({ workspaceId, personId: viewer.id, role: "viewer" }),
		);

		await expect(
			administrationAs(viewer.id).create({
				workspace: workspaceId,
				bot: { name: "Scout", model: OFFERED },
			}),
		).rejects.toBeInstanceOf(ActionForbidden);
		await expect(
			administrationAs(viewer.id).setSystemBotModel({
				workspace: workspaceId,
				key: "compact",
				model: OFFERED,
			}),
		).rejects.toBeInstanceOf(ActionForbidden);
		expect(await listedTo(administrationAs(viewer.id), made.id)).toMatchObject({ id: made.id });
		await expect(administrationAs(stranger.id).remove({ botId: made.id })).rejects.toBeInstanceOf(
			ResourceHidden,
		);
	});

	/** Lee, an editor in the workspace. */
	const anEditor = async () => {
		const [editor] = await onDatabase((db) =>
			db
				.insert(person)
				.values({ name: "Lee", email: `lee-${crypto.randomUUID()}@example.com` })
				.returning(),
		);
		if (!editor) throw new Error("could not create the editor");
		await onDatabase((db) =>
			db.insert(membership).values({ workspaceId, personId: editor.id, role: "editor" }),
		);
		return editor.id;
	};

	it("lets only a bot's creator or an admin let it use its computer", async () => {
		const asEditor = administrationAs(await anEditor());
		const admins = await administration.create({
			workspace: workspaceId,
			bot: { name: "Triage", model: OFFERED },
		});

		await expect(
			asEditor.update({ botId: admins.id, changes: { usesComputer: true } }),
		).rejects.toBeInstanceOf(ActionForbidden);
		const own = await asEditor.create({
			workspace: workspaceId,
			bot: { name: "Scout", model: OFFERED, usesComputer: true },
		});
		expect(own.usesComputer).toBe(true);
		expect(
			(await asEditor.update({ botId: own.id, changes: { usesComputer: false } })).usesComputer,
		).toBe(false);
	});

	it("destroys a deleted bot's computer, and keeps the bot when its provider can't be reached", async () => {
		const made = await administration.create({
			workspace: workspaceId,
			bot: { name: "Builder", model: OFFERED },
		});

		providerReachable = false;
		await expect(administration.remove({ botId: made.id })).rejects.toMatchObject({
			_tag: "ComputerUnavailable",
		});
		expect(
			await onDatabase((db) => db.select({ id: bot.id }).from(bot).where(eq(bot.id, made.id))),
		).toEqual([{ id: made.id }]);

		providerReachable = true;
		const ownProject = await runOnPostgres(defaultProjectOf(made.id));
		await administration.remove({ botId: made.id });
		expect(destroyedComputers).toEqual([ownProject]);
		expect(await onDatabase((db) => db.select().from(bot).where(eq(bot.id, made.id)))).toEqual([]);
	});

	it("keeps a bot's computer when its deletion is refused for a lead chosen meanwhile", async () => {
		const made = await administration.create({
			workspace: workspaceId,
			bot: { name: "Builder", model: OFFERED },
		});
		const launch = await onDatabase((db) =>
			seedProject(db, { workspaceId, name: "Launch", slug: "launch" }),
		);
		if (!launch) throw new Error("could not create the project");
		const choosing = holdTransaction(
			Effect.flatMap(ProjectStore.Service, (projects) =>
				projects.update(workspaceId, launch.id, { leadBotId: made.id }),
			).pipe(Effect.provide(ProjectStore.layer)),
		);
		await choosing.held;

		const removing = administration.remove({ botId: made.id });
		await waitUntilWaitingOnLocks(1);
		await choosing.release();

		await expect(removing).rejects.toBeInstanceOf(LeadsProjects);
		expect(destroyedComputers).toEqual([]);
	});

	it("pins a bot to the actor's sidebar and takes it off again", async () => {
		const asEditor = administrationAs(await anEditor());
		const made = await administration.create({
			workspace: workspaceId,
			bot: { name: "Triage", model: OFFERED },
		});

		expect(await asEditor.setPinned({ botId: made.id, pinned: true })).toMatchObject({
			pinned: true,
		});
		expect(await asEditor.setPinned({ botId: made.id, pinned: false })).toMatchObject({
			pinned: false,
		});
		expect(await listedTo(administration, made.id)).toMatchObject({ pinned: true });
	});

	it("takes a bot made private out of every project people made that it was in", async () => {
		const made = await administration.create({
			workspace: workspaceId,
			bot: { name: "Triage", model: OFFERED },
		});
		const launch = await onDatabase((db) =>
			seedProject(db, { workspaceId, name: "Launch", slug: "launch" }),
		);
		if (!launch) throw new Error("could not create the project");
		await onDatabase((db) =>
			db.insert(projectBot).values({ workspaceId, projectId: launch.id, botId: made.id }),
		);

		await administration.update({ botId: made.id, changes: { visibility: "private" } });

		expect(
			await onDatabase((db) =>
				db
					.select()
					.from(projectBot)
					.where(and(eq(projectBot.projectId, launch.id), eq(projectBot.botId, made.id))),
			),
		).toEqual([]);
	});

	describe("a Personal Assistant", () => {
		it("is made once for the person who asks, and kept private", async () => {
			const first = await administration.ensureAssistant({
				workspace: workspaceId,
				model: OFFERED,
			});
			const again = await administration.ensureAssistant({ workspace: workspaceId });

			expect(first).toMatchObject({ assistant: true, model: OFFERED });
			expect(again.id).toBe(first.id);
			await expect(
				administration.update({ botId: first.id, changes: { visibility: "public" } }),
			).rejects.toBeInstanceOf(BotAdministration.AssistantStaysPrivate);
		});

		it("keeps what its person changed when it is asked for again", async () => {
			const made = await administration.ensureAssistant({ workspace: workspaceId, model: OFFERED });
			await onDatabase((db) =>
				db.update(bot).set({ name: "Friday", prompt: "Keep this." }).where(eq(bot.id, made.id)),
			);

			const again = await assistants.provisionWithModel({
				workspaceId,
				personId: creatorId,
				model: ALSO_OFFERED,
			});

			expect(again).toMatchObject({
				id: made.id,
				name: "Friday",
				prompt: "Keep this.",
				model: OFFERED,
			});
		});

		it("moves to the model named when the workspace does not offer its own", async () => {
			// Made without a model, as for somebody joining a workspace that offers none.
			const unassigned = await assistants.provision({ workspaceId, personId: creatorId });
			expect(unassigned.model).toBeNull();

			const moved = await assistants.provisionWithModel({
				workspaceId,
				personId: creatorId,
				model: ALSO_OFFERED,
			});

			expect(moved).toMatchObject({ id: unassigned.id, model: ALSO_OFFERED });
		});

		it("moves onto the model its person picks when it has none, as at workspace setup", async () => {
			const unassigned = await administration.ensureAssistant({ workspace: workspaceId });
			expect(unassigned.model).toBeNull();

			const picked = await administration.ensureAssistant({
				workspace: workspaceId,
				model: ALSO_OFFERED,
			});

			expect(picked).toMatchObject({ id: unassigned.id, model: ALSO_OFFERED });
		});

		it("is given the workspace's default model when it has none", async () => {
			const unassigned = await administration.ensureAssistant({ workspace: workspaceId });
			await onDatabase((db) =>
				db.insert(workspaceDefaultModel).values({ workspaceId, modelId: OFFERED }),
			);

			const again = await administration.ensureAssistant({ workspace: workspaceId });

			expect(again).toMatchObject({ id: unassigned.id, model: OFFERED });
		});

		it("is not made on a model the workspace does not offer", async () => {
			await expect(
				administration.ensureAssistant({ workspace: workspaceId, model: "switched-off" }),
			).rejects.toBeInstanceOf(ModelProviderStore.ModelNotEnabled);
		});

		it("lets its person change only its name and look", async () => {
			const assistant = await administration.ensureAssistant({
				workspace: workspaceId,
				model: OFFERED,
			});

			expect(
				await administration.update({
					botId: assistant.id,
					changes: { name: "Friday", color: "green", eyes: "square", shape: "circle" },
				}),
			).toMatchObject({ name: "Friday", color: "green" });
			for (const changes of [
				{ description: "Mine" },
				{ handle: "friday" },
				{ model: ALSO_OFFERED },
				{ usesComputer: false },
				{ disabledTools: ["automations"] },
				{ name: "Saturday", naturalBrowsing: true },
			]) {
				await expect(
					administration.update({ botId: assistant.id, changes }),
				).rejects.toBeInstanceOf(BotAdministration.AssistantManaged);
			}
		});

		it("is hidden from everybody but its somebody, an admin included", async () => {
			const editorId = await anEditor();
			const assistant = await administrationAs(editorId).ensureAssistant({
				workspace: workspaceId,
			});

			expect(
				(await administration.list({ workspace: workspaceId })).map(({ id }) => id),
			).not.toContain(assistant.id);
			await expect(administration.remove({ botId: assistant.id })).rejects.toBeInstanceOf(
				ResourceHidden,
			);
		});
	});

	describe("a bot the actor did not make", () => {
		it("lets an administrator change and remove another person's public bot", async () => {
			const made = await administrationAs(await anEditor()).create({
				workspace: workspaceId,
				bot: { name: "Triage", model: OFFERED },
			});

			expect(
				await administration.update({ botId: made.id, changes: { name: "Sorter" } }),
			).toMatchObject({ id: made.id, name: "Sorter" });
			await administration.remove({ botId: made.id });

			expect(await onDatabase((db) => db.select().from(bot).where(eq(bot.id, made.id)))).toEqual(
				[],
			);
		});

		it("names nobody as its creator once they have left the workspace, though they are in another", async () => {
			const editorId = await anEditor();
			const made = await administrationAs(editorId).create({
				workspace: workspaceId,
				bot: { name: "Triage", model: OFFERED },
			});
			const [elsewhere] = await onDatabase((db) =>
				db
					.insert(workspace)
					.values({ name: "Elsewhere", slug: `elsewhere-${crypto.randomUUID()}` })
					.returning(),
			);
			if (!elsewhere) throw new Error("could not create the other workspace");
			await onDatabase((db) =>
				db
					.insert(membership)
					.values({ workspaceId: elsewhere.id, personId: editorId, role: "editor" }),
			);
			await onDatabase((db) =>
				db
					.delete(membership)
					.where(and(eq(membership.workspaceId, workspaceId), eq(membership.personId, editorId))),
			);

			const listed = await administration.list({ workspace: workspaceId });
			expect(listed.find((one) => one.id === made.id)?.createdBy).toBeNull();
		});

		it("lets an administrator read and change another person's private bot, but not talk to it", async () => {
			const made = await administrationAs(await anEditor()).create({
				workspace: workspaceId,
				bot: { name: "Diary", model: OFFERED, visibility: "private" },
			});

			expect(await listedTo(administration, made.id)).toMatchObject({
				name: "Diary",
				permissions: { talk: false, update: true },
			});
			expect(
				await administration.update({ botId: made.id, changes: { name: "Journal" } }),
			).toMatchObject({ name: "Journal", permissions: { talk: false } });
		});

		it("lets an editor use another person's public bot but not change it, and hides a private one", async () => {
			const asEditor = administrationAs(await anEditor());
			const shared = await administration.create({
				workspace: workspaceId,
				bot: { name: "Triage", model: OFFERED },
			});
			const hidden = await administration.create({
				workspace: workspaceId,
				bot: { name: "Ledger", model: OFFERED, visibility: "private" },
			});

			expect(await listedTo(asEditor, shared.id)).toMatchObject({
				permissions: { talk: true, update: false },
			});
			await expect(
				asEditor.update({ botId: shared.id, changes: { name: "Mine now" } }),
			).rejects.toBeInstanceOf(ActionForbidden);
			await expect(asEditor.remove({ botId: shared.id })).rejects.toBeInstanceOf(ActionForbidden);
			expect(await listedTo(asEditor, hidden.id)).toBeUndefined();
			await expect(
				asEditor.update({ botId: hidden.id, changes: { name: "Mine now" } }),
			).rejects.toBeInstanceOf(ResourceHidden);
		});
	});
});
