import { and, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ActionForbidden, ResourceHidden } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import { Computers } from "../../computers/computers.ts";
import { ProjectComputers } from "../../computers/project-computers.ts";
import {
	bot,
	modelProvider,
	project,
	projectBot,
	providerModel,
	user,
	workspace,
	workspaceDefaultModel,
	workspaceMember,
} from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	type Promised,
	runOnPostgres,
	servedOnPostgres,
} from "../../database/testing.ts";
import { ModelProviderRepository } from "../../providers/model-providers/model-provider-repository.ts";
import { unimplemented } from "../../testing.ts";
import { defaultProjectOf } from "../projects/project-reads.ts";
import { servedOnPostgresAs } from "../testing.ts";
import { BotAdministration } from "./bot-administration.ts";
import { BotRepository } from "./bot-repository.ts";
import { PersonalAssistants } from "./personal-assistants.ts";

/** Bots run only on a model the workspace offers, which here is `OFFERED`. */
const OFFERED = "offered-model";
const ALSO_OFFERED = "also-offered-model";

describe.skipIf(!process.env.DATABASE_URL)("administering bots", () => {
	let bots: Promised<BotRepository.Interface>;
	let assistants: Promised<PersonalAssistants.Interface>;
	let administrationAs: (userId: string) => Promised<BotAdministration.Interface>;
	/** The administration as the workspace's administrator. */
	let administration: Promised<BotAdministration.Interface>;
	let workspaceId: string;
	let creatorId: string;
	/** The projects whose computers were destroyed, in order. */
	let destroyedComputers: string[] = [];
	let providerReachable = true;

	beforeAll(async () => {
		bots = await servedOnPostgres(BotRepository.Service, BotRepository.layer);
		assistants = await servedOnPostgres(PersonalAssistants.Service, PersonalAssistants.layer);
		administrationAs = await servedOnPostgresAs(
			BotAdministration.Service,
			BotAdministration.layerNoDeps.pipe(
				Layer.provide([
					Authorization.layer,
					BotRepository.layer,
					ModelProviderRepository.layer,
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
		const [person] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Ada", email: `ada-${stamp}@example.com` })
				.returning(),
		);
		if (!space || !person) throw new Error("could not create the fixtures");
		workspaceId = space.id;
		creatorId = person.id;
		administration = administrationAs(creatorId);
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId, userId: creatorId, role: "admin" }),
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

	it.each(["unknown-model", "switched-off"])(
		"refuses to create a bot on %s, and creates nothing",
		async (model) => {
			await expect(
				administration.create({ workspace: workspaceId, bot: { name: "Triage", model } }),
			).rejects.toBeInstanceOf(ModelProviderRepository.ModelNotEnabled);

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
		).rejects.toBeInstanceOf(ModelProviderRepository.ModelNotEnabled);
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
				key: "summarise",
				model: "unknown-model",
			}),
		).rejects.toBeInstanceOf(ModelProviderRepository.ModelNotEnabled);
		expect(
			(
				await administration.setSystemBotModel({
					workspace: workspaceId,
					key: "summarise",
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
				.insert(user)
				.values([
					{ name: "Lee", email: `lee-${crypto.randomUUID()}@example.com` },
					{ name: "Kim", email: `kim-${crypto.randomUUID()}@example.com` },
				])
				.returning(),
		);
		if (!viewer || !stranger) throw new Error("could not create the people");
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId, userId: viewer.id, role: "viewer" }),
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
				key: "summarise",
				model: OFFERED,
			}),
		).rejects.toBeInstanceOf(ActionForbidden);
		expect(await administrationAs(viewer.id).get({ botId: made.id })).toMatchObject({
			id: made.id,
		});
		await expect(administrationAs(stranger.id).get({ botId: made.id })).rejects.toBeInstanceOf(
			ResourceHidden,
		);
		await expect(administrationAs(stranger.id).remove({ botId: made.id })).rejects.toBeInstanceOf(
			ResourceHidden,
		);
	});

	/** Lee, a member of the workspace. */
	const aMember = async () => {
		const [member] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Lee", email: `lee-${crypto.randomUUID()}@example.com` })
				.returning(),
		);
		if (!member) throw new Error("could not create the member");
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId, userId: member.id, role: "member" }),
		);
		return member.id;
	};

	it("lets only a bot's creator or an admin let it use its computer", async () => {
		const asMember = administrationAs(await aMember());
		const admins = await administration.create({
			workspace: workspaceId,
			bot: { name: "Triage", model: OFFERED },
		});

		await expect(
			asMember.update({ botId: admins.id, changes: { usesComputer: true } }),
		).rejects.toBeInstanceOf(ActionForbidden);
		const own = await asMember.create({
			workspace: workspaceId,
			bot: { name: "Scout", model: OFFERED, usesComputer: true },
		});
		expect(own.usesComputer).toBe(true);
		expect(
			(await asMember.update({ botId: own.id, changes: { usesComputer: false } })).usesComputer,
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

	it("pins a bot to the actor's sidebar and takes it off again", async () => {
		const asMember = administrationAs(await aMember());
		const made = await administration.create({
			workspace: workspaceId,
			bot: { name: "Triage", model: OFFERED },
		});

		expect(await asMember.setPinned({ botId: made.id, pinned: true })).toMatchObject({
			pinned: true,
		});
		expect(await asMember.setPinned({ botId: made.id, pinned: false })).toMatchObject({
			pinned: false,
		});
		expect(await administration.get({ botId: made.id })).toMatchObject({ pinned: true });
	});

	it("takes a bot made private out of every project it was in", async () => {
		const made = await administration.create({
			workspace: workspaceId,
			bot: { name: "Triage", model: OFFERED },
		});
		const [launch] = await onDatabase((db) =>
			db.insert(project).values({ workspaceId, name: "Launch", slug: "launch" }).returning(),
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
				userId: creatorId,
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
			const unassigned = await assistants.provision({ workspaceId, userId: creatorId });
			expect(unassigned.model).toBeNull();

			const moved = await assistants.provisionWithModel({
				workspaceId,
				userId: creatorId,
				model: ALSO_OFFERED,
			});

			expect(moved).toMatchObject({ id: unassigned.id, model: ALSO_OFFERED });
		});

		it("moves onto the model its person picks when it has none, as at onboarding", async () => {
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
			).rejects.toBeInstanceOf(ModelProviderRepository.ModelNotEnabled);
		});

		it("lets its person change only its name and look", async () => {
			const assistant = await administration.ensureAssistant({
				workspace: workspaceId,
				model: OFFERED,
			});

			expect(
				await administration.update({
					botId: assistant.id,
					changes: { name: "Friday", color: "green", face: "square", shape: "circle" },
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

		it("is hidden from everybody but its person, an admin included", async () => {
			const memberId = await aMember();
			const assistant = await administrationAs(memberId).ensureAssistant({
				workspace: workspaceId,
			});

			await expect(administration.get({ botId: assistant.id })).rejects.toBeInstanceOf(
				ResourceHidden,
			);
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
			const made = await administrationAs(await aMember()).create({
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

		it("lets an administrator read and change another person's private bot, but not talk to it", async () => {
			const made = await administrationAs(await aMember()).create({
				workspace: workspaceId,
				bot: { name: "Diary", model: OFFERED, visibility: "private" },
			});

			expect(await administration.get({ botId: made.id })).toMatchObject({
				name: "Diary",
				permissions: { talk: false, update: true },
			});
			expect(
				await administration.update({ botId: made.id, changes: { name: "Journal" } }),
			).toMatchObject({ name: "Journal", permissions: { talk: false } });
		});

		it("lets a member use another person's public bot but not change it, and hides a private one", async () => {
			const asMember = administrationAs(await aMember());
			const shared = await administration.create({
				workspace: workspaceId,
				bot: { name: "Triage", model: OFFERED },
			});
			const hidden = await administration.create({
				workspace: workspaceId,
				bot: { name: "Ledger", model: OFFERED, visibility: "private" },
			});

			expect(await asMember.get({ botId: shared.id })).toMatchObject({
				permissions: { talk: true, update: false },
			});
			await expect(
				asMember.update({ botId: shared.id, changes: { name: "Mine now" } }),
			).rejects.toBeInstanceOf(ActionForbidden);
			await expect(asMember.remove({ botId: shared.id })).rejects.toBeInstanceOf(ActionForbidden);
			await expect(asMember.get({ botId: hidden.id })).rejects.toBeInstanceOf(ResourceHidden);
			await expect(
				asMember.update({ botId: hidden.id, changes: { name: "Mine now" } }),
			).rejects.toBeInstanceOf(ResourceHidden);
		});
	});
});
