import type { ChannelColor, ChannelVisibility } from "@sugabots/contracts";
import { and, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ActionForbidden, ResourceHidden } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import { noComputers } from "../../computers/testing.ts";
import { transaction } from "../../database/database.ts";
import {
	channel,
	channelMember,
	modelProvider,
	providerModel,
	user,
	workspace,
	workspaceMember,
} from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	type Promised,
	runOnPostgres,
	servedOnPostgres,
} from "../../database/testing.ts";
import { BotAdministration } from "../bots/bot-administration.ts";
import { BotRepository } from "../bots/bot-repository.ts";
import { servedOnPostgresAs } from "../testing.ts";
import { ChannelAdministration } from "./channel-administration.ts";
import { ChannelRepository } from "./channel-repository.ts";

/**
 * Channels: the repository, the administration over it, and the authorisation
 * queries against real SQL.
 *
 * The joins behind `Authorization.channel`, the query a list is scoped by, and the
 * create-plus-membership transaction are exactly the parts a fake cannot
 * check. Needs a migrated database and skips without one, as
 * `db/schema.test.ts` does; CI always has one.
 */
describe.skipIf(!process.env.DATABASE_URL)("channels, against Postgres", () => {
	let repository: Promised<ChannelRepository.Interface>;
	let administrationAs: (userId: string) => Promised<ChannelAdministration.Interface>;
	let botsAs: (userId: string) => Promised<BotAdministration.Interface>;
	let authorizationAs: (userId: string) => Promised<Authorization.Interface>;

	let workspaceId: string;
	let otherWorkspaceId: string;
	let adminId: string;
	let memberId: string;
	let viewerId: string;
	let outsiderId: string;

	beforeAll(async () => {
		repository = await servedOnPostgres(ChannelRepository.Service, ChannelRepository.layer);
		administrationAs = await servedOnPostgresAs(
			ChannelAdministration.Service,
			ChannelAdministration.layer,
		);
		botsAs = await servedOnPostgresAs(
			BotAdministration.Service,
			BotAdministration.layer.pipe(Layer.provide(noComputers)),
		);
		authorizationAs = await servedOnPostgresAs(Authorization.Service, Authorization.layer);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	const create = (
		creatorId: string,
		input: { name: string; slug: string; color?: ChannelColor; visibility?: ChannelVisibility },
	) => administrationAs(creatorId).create({ workspace: workspaceId, ...input });
	const createIn = (
		inWorkspace: string,
		creatorId: string,
		input: { name: string; slug: string; visibility?: ChannelVisibility },
	) => administrationAs(creatorId).create({ workspace: inWorkspace, ...input });
	const visibleTo = (userId: string, inWorkspace = workspaceId) =>
		administrationAs(userId).list({ workspace: inWorkspace });
	/** The ids of the channels `userId` is listed, with whether they are in each. */
	const listedTo = async (userId: string, inWorkspace = workspaceId) =>
		(await visibleTo(userId, inWorkspace)).map(({ id, isMember }) => ({ id, isMember }));
	/** A bot `creatorId` made, public unless said otherwise. */
	const aBot = async (creatorId: string, name: string, visibility?: "public" | "private") =>
		botsAs(creatorId).create({
			workspace: workspaceId,
			bot: { name, model: "test-model", visibility },
		});
	const membersOf = (channelId: string) => administrationAs(adminId).members({ channelId });

	beforeEach(async () => {
		// A fresh workspace per test rather than a truncate, so these can run
		// against a database that has the dev seed in it.
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

		const [made] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Test ${stamp}`, slug: `test-${stamp}` })
				.returning(),
		);
		const [other] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Other ${stamp}`, slug: `other-${stamp}` })
				.returning(),
		);
		if (!made || !other) {
			throw new Error("could not create the test workspaces");
		}
		workspaceId = made.id;
		otherWorkspaceId = other.id;

		const people = await onDatabase((db) =>
			db
				.insert(user)
				.values([
					{ name: "Ada", email: `ada-${stamp}@example.com` },
					{ name: "Sam", email: `sam-${stamp}@example.com` },
					{ name: "Kim", email: `kim-${stamp}@example.com` },
					{ name: "Lee", email: `lee-${stamp}@example.com` },
				])
				.returning(),
		);
		const [ada, sam, kim, lee] = people;
		if (!ada || !sam || !kim || !lee) {
			throw new Error("could not create the test people");
		}
		adminId = ada.id;
		memberId = sam.id;
		outsiderId = kim.id;
		viewerId = lee.id;

		await onDatabase((db) =>
			db.insert(workspaceMember).values([
				{ workspaceId, userId: adminId, role: "admin" },
				{ workspaceId, userId: memberId, role: "member" },
				{ workspaceId, userId: viewerId, role: "viewer" },
				{ workspaceId: otherWorkspaceId, userId: adminId, role: "admin" },
				{ workspaceId: otherWorkspaceId, userId: outsiderId, role: "member" },
			]),
		);

		// The model the cases make bots on.
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
		if (!provider) {
			throw new Error("could not create the test model provider");
		}
		await onDatabase((db) =>
			db.insert(providerModel).values(
				["test-model"].map((modelId) => ({
					workspaceId,
					providerId: provider.id,
					modelId,
					enabled: true,
					source: "manual" as const,
				})),
			),
		);
	});

	describe("creating", () => {
		it("puts the creator in the channel, and lists a public one to everybody to join", async () => {
			const made = await create(memberId, { name: "Suga", slug: "suga" });

			expect(made).toMatchObject({ visibility: "public", isMember: true });
			expect(await listedTo(memberId)).toEqual([{ id: made.id, isMember: true }]);
			expect(await visibleTo(viewerId)).toEqual([
				expect.objectContaining({
					id: made.id,
					isMember: false,
					permissions: expect.objectContaining({ join: true, leave: false }),
				}),
			]);
		});

		it("lists a private channel only to the people in it", async () => {
			const made = await create(memberId, { name: "Suga", slug: "suga", visibility: "private" });

			expect(await listedTo(memberId)).toEqual([{ id: made.id, isMember: true }]);
			// Administrators are in every channel, private ones included.
			expect(await listedTo(adminId)).toEqual([{ id: made.id, isMember: true }]);
			expect(await visibleTo(viewerId)).toEqual([]);
		});

		it("refuses a slug already used in the same workspace", async () => {
			await create(adminId, { name: "Suga", slug: "suga" });

			await expect(create(adminId, { name: "Suga again", slug: "suga" })).rejects.toThrow(
				ChannelRepository.ChannelSlugTaken,
			);
		});

		it("allows the same slug in another workspace", async () => {
			await create(adminId, { name: "General", slug: "general" });

			await expect(
				createIn(otherWorkspaceId, adminId, { name: "General", slug: "general" }),
			).resolves.toMatchObject({ slug: "general" });
		});

		it("leaves nothing behind when the slug is taken", async () => {
			await create(adminId, { name: "Suga", slug: "suga" });
			await create(adminId, { name: "Sales", slug: "sales" }).catch(() => {});
			await create(adminId, { name: "Dup", slug: "suga" }).catch(() => {});

			const rows = await onDatabase((db) => db.select().from(channel));
			expect(rows.filter((row) => row.workspaceId === workspaceId)).toHaveLength(2);
		});

		it("gives a channel with no colour chosen one no other channel in the workspace has yet", async () => {
			await create(adminId, { name: "Suga", slug: "suga", color: "green" });
			await create(adminId, { name: "Sales", slug: "sales", color: "plum" });

			const made = await create(adminId, { name: "Ops", slug: "ops" });

			expect(made.color).toBe("blue");
		});
	});

	describe("membership", () => {
		it("adds, lists and removes people", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });

			await repository.addMember(workspaceId, made.id, memberId);
			expect((await membersOf(made.id)).map((row) => row.name)).toEqual(["Ada", "Sam"]);

			expect(await repository.removeMember(workspaceId, made.id, memberId)).toBe("removed");
			expect((await membersOf(made.id)).map((row) => row.name)).toEqual(["Ada"]);
		});

		it("is idempotent, so adding twice is not an error", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });

			await repository.addMember(workspaceId, made.id, memberId);
			await repository.addMember(workspaceId, made.id, memberId);

			expect(await membersOf(made.id)).toHaveLength(2);
		});

		it("does not add somebody from another workspace", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });

			expect(await repository.addMember(workspaceId, made.id, outsiderId)).toBe(
				"not_workspace_member",
			);
		});

		it("rejects a cross-workspace membership at the database boundary", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });

			await expect(
				onDatabase((db) =>
					db.insert(channelMember).values({ workspaceId, channelId: made.id, userId: outsiderId }),
				),
			).rejects.toThrow();
		});

		it("takes somebody out of their channels when they leave the workspace, and does not put them back", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga", visibility: "private" });
			await repository.addMember(workspaceId, made.id, memberId);

			await onDatabase((db) =>
				db
					.delete(workspaceMember)
					.where(
						and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, memberId)),
					),
			);
			await onDatabase((db) =>
				db.insert(workspaceMember).values({ workspaceId, userId: memberId }),
			);

			expect(await visibleTo(memberId)).toEqual([]);
			expect((await membersOf(made.id)).map(({ userId }) => userId)).not.toContain(memberId);
			await expect(authorizationAs(memberId).channel(made.id, "channel.read")).rejects.toThrow(
				ResourceHidden,
			);
		});
	});

	describe("joining and inviting", () => {
		it("lets anybody in the workspace join a public channel, once", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });

			expect(await administrationAs(viewerId).join({ channelId: made.id })).toMatchObject({
				isMember: true,
				permissions: { join: false, leave: true },
			});
			await administrationAs(viewerId).join({ channelId: made.id });

			expect((await membersOf(made.id)).map(({ userId }) => userId).toSorted()).toEqual(
				[adminId, viewerId].toSorted(),
			);
		});

		it("does not let anybody join a private channel, and hides it from them", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga", visibility: "private" });

			await expect(administrationAs(memberId).join({ channelId: made.id })).rejects.toThrow(
				ResourceHidden,
			);
			await expect(administrationAs(outsiderId).join({ channelId: made.id })).rejects.toThrow(
				ResourceHidden,
			);
		});

		it("lets a member in a channel invite and remove people, and a viewer neither", async () => {
			const made = await create(memberId, { name: "Suga", slug: "suga", visibility: "private" });

			await administrationAs(memberId).addMember({ channelId: made.id, userId: viewerId });
			await expect(
				administrationAs(viewerId).removeMember({ channelId: made.id, userId: memberId }),
			).rejects.toThrow(ActionForbidden);
			await administrationAs(memberId).removeMember({ channelId: made.id, userId: viewerId });

			expect((await membersOf(made.id)).map(({ userId }) => userId).toSorted()).toEqual(
				[adminId, memberId].toSorted(),
			);
			await expect(
				administrationAs(memberId).removeMember({ channelId: made.id, userId: viewerId }),
			).rejects.toBeInstanceOf(ChannelAdministration.NotInChannel);
			await expect(
				administrationAs(memberId).removeMember({ channelId: made.id, userId: adminId }),
			).rejects.toBeInstanceOf(ChannelAdministration.AdministratorInEveryChannel);
			await expect(
				administrationAs(memberId).addMember({ channelId: made.id, userId: outsiderId }),
			).rejects.toBeInstanceOf(ChannelAdministration.NotInWorkspace);
		});
	});

	describe("bots", () => {
		it("adds a public bot to a channel, lists it, and takes it out", async () => {
			const made = await create(memberId, { name: "Suga", slug: "suga" });
			const bot = await aBot(adminId, "Triage");

			await administrationAs(memberId).addBot({ channelId: made.id, botId: bot.id });
			await administrationAs(memberId).addBot({ channelId: made.id, botId: bot.id });
			expect(
				(await administrationAs(memberId).bots({ channelId: made.id })).map(({ id }) => id),
			).toEqual([bot.id]);

			await administrationAs(memberId).removeBot({ channelId: made.id, botId: bot.id });
			expect(await administrationAs(memberId).bots({ channelId: made.id })).toEqual([]);
		});

		it("refuses a private bot, even its creator's, and hides one the person doesn't reach", async () => {
			const made = await create(memberId, { name: "Suga", slug: "suga" });
			const own = await aBot(memberId, "Diary", "private");
			const someoneElses = await aBot(adminId, "Ledger", "private");

			await expect(
				administrationAs(memberId).addBot({ channelId: made.id, botId: own.id }),
			).rejects.toBeInstanceOf(ChannelRepository.BotNotPublic);
			await expect(
				administrationAs(memberId).addBot({ channelId: made.id, botId: someoneElses.id }),
			).rejects.toThrow(ResourceHidden);
			expect(await administrationAs(memberId).bots({ channelId: made.id })).toEqual([]);
		});

		it("does not add a bot being made private at the same time", async () => {
			const made = await create(memberId, { name: "Suga", slug: "suga" });
			const bot = await aBot(adminId, "Triage");
			let release = () => {};
			const released = new Promise<void>((resolve) => {
				release = resolve;
			});
			let madePrivate = () => {};
			const privateUncommitted = new Promise<void>((resolve) => {
				madePrivate = resolve;
			});
			const makingPrivate = runOnPostgres(
				transaction(
					Effect.gen(function* () {
						const bots = yield* BotRepository.Service;
						yield* bots.update(workspaceId, bot.id, { visibility: "private" });
						madePrivate();
						yield* Effect.promise(() => released);
					}),
				).pipe(Effect.provide(BotRepository.layer)),
			);
			await privateUncommitted;

			const adding = repository.addBot(workspaceId, made.id, bot.id);
			await new Promise((resolve) => setTimeout(resolve, 300));
			release();
			await makingPrivate;

			await expect(adding).rejects.toBeInstanceOf(ChannelRepository.BotNotPublic);
			expect(await administrationAs(adminId).bots({ channelId: made.id })).toEqual([]);
		});

		it("does not let a viewer add a bot", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });
			const bot = await aBot(adminId, "Triage");
			await repository.addMember(workspaceId, made.id, viewerId);

			await expect(
				administrationAs(viewerId).addBot({ channelId: made.id, botId: bot.id }),
			).rejects.toThrow(ActionForbidden);
		});
	});

	describe("renaming", () => {
		it("refuses a slug another channel in the workspace holds", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });
			await create(adminId, { name: "Sales", slug: "sales" });

			await expect(repository.update(workspaceId, made.id, { slug: "sales" })).rejects.toThrow(
				ChannelRepository.ChannelSlugTaken,
			);
		});

		it("says the channel is gone, not that its slug is taken", async () => {
			// Renaming a channel somebody else deleted in between.
			const made = await create(adminId, { name: "Suga", slug: "suga" });
			await repository.remove(workspaceId, made.id);

			await expect(repository.update(workspaceId, made.id, { name: "Platform" })).rejects.toThrow(
				ChannelRepository.ChannelGone,
			);
		});
	});

	describe("authorisation", () => {
		it("lets a member of the workspace in, and keeps an outsider out", async () => {
			expect(await authorizationAs(adminId).workspace(workspaceId, "channel.create")).toMatchObject(
				{
					actor: { workspaceRole: "admin" },
				},
			);
			expect(
				await authorizationAs(memberId).workspace(workspaceId, "channel.create"),
			).toMatchObject({
				actor: { workspaceRole: "member" },
			});
			await expect(
				authorizationAs(viewerId).workspace(workspaceId, "channel.create"),
			).rejects.toThrow(ActionForbidden);
			await expect(
				authorizationAs(outsiderId).workspace(workspaceId, "workspace.read"),
			).rejects.toThrow(ResourceHidden);
		});

		it("puts every administrator in a new channel, and keeps them there", async () => {
			await onDatabase((db) =>
				db
					.update(workspaceMember)
					.set({ role: "admin" })
					.where(
						and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, viewerId)),
					),
			);

			const made = await create(adminId, { name: "Sales", slug: "sales" });

			expect((await membersOf(made.id)).map(({ userId }) => userId).toSorted()).toEqual(
				[adminId, viewerId].toSorted(),
			);
			expect(await repository.removeMember(workspaceId, made.id, viewerId)).toBe("administrator");
		});

		it("gives a member the channels they are in, and nothing else", async () => {
			const joined = await create(adminId, { name: "Sales", slug: "sales" });
			const apart = await create(adminId, { name: "Legal", slug: "legal" });
			await repository.addMember(workspaceId, joined.id, memberId);

			expect(
				await authorizationAs(memberId).channel(joined.id, "channel.bots.manage"),
			).toMatchObject({
				facts: { isMember: true },
			});
			await expect(authorizationAs(memberId).channel(joined.id, "channel.delete")).rejects.toThrow(
				ActionForbidden,
			);
			// Listed to join, but not reached until they do.
			await expect(authorizationAs(memberId).channel(apart.id, "channel.read")).rejects.toThrow(
				ResourceHidden,
			);
		});

		it("lists exactly the channels each role may read one by one as theirs, and other public ones to join", async () => {
			const joined = await create(adminId, { name: "Sales", slug: "sales" });
			const apart = await create(adminId, { name: "Legal", slug: "legal" });
			const secret = await create(adminId, { name: "Board", slug: "board", visibility: "private" });
			await repository.addMember(workspaceId, joined.id, memberId);
			await repository.addMember(workspaceId, joined.id, viewerId);
			const people = { admin: adminId, member: memberId, viewer: viewerId };
			const channels: Record<string, { id: string; isPublic: boolean }> = {
				"public, with the member and viewer in it": { id: joined.id, isPublic: true },
				"public, with only the administrator in it": { id: apart.id, isPublic: true },
				"private, with only the administrator in it": { id: secret.id, isPublic: false },
			};

			for (const [role, userId] of Object.entries(people)) {
				const listed = new Map((await listedTo(userId)).map(({ id, isMember }) => [id, isMember]));
				for (const [channel, { id, isPublic }] of Object.entries(channels)) {
					const readable = await authorizationAs(userId)
						.channel(id, "channel.read")
						.then(() => true)
						.catch((refusal) =>
							refusal instanceof ResourceHidden ? false : Promise.reject(refusal),
						);
					expect({ role, channel, listed: listed.get(id) }).toEqual({
						role,
						channel,
						listed: readable ? true : isPublic ? false : undefined,
					});
				}
			}
		});

		it("carries the resolved permissions on each channel it lists", async () => {
			const made = await create(adminId, { name: "Sales", slug: "sales" });
			await repository.addMember(workspaceId, made.id, memberId);

			const [seen] = (await visibleTo(memberId)).filter(({ id }) => id === made.id);

			expect(seen?.permissions).toEqual({
				rename: false,
				manageMembers: true,
				manageBots: true,
				leave: true,
				join: false,
				delete: false,
				deleteFiles: false,
			});
		});

		it("gives a viewer the channels they are in, to read and take part in", async () => {
			const joined = await create(adminId, { name: "Sales", slug: "sales" });
			const apart = await create(adminId, { name: "Legal", slug: "legal", visibility: "private" });
			await repository.addMember(workspaceId, joined.id, viewerId);

			const standing = await authorizationAs(viewerId).channel(joined.id, "channel.read");

			expect(standing.may("approval.decide")).toBe(false);
			await expect(
				authorizationAs(viewerId).channel(joined.id, "channel.bots.manage"),
			).rejects.toThrow(ActionForbidden);
			await expect(authorizationAs(viewerId).channel(apart.id, "channel.read")).rejects.toThrow(
				ResourceHidden,
			);
			expect(await listedTo(viewerId)).toEqual([{ id: joined.id, isMember: true }]);
		});

		it("carries a viewer's permissions on the channels it lists, all closed but leaving", async () => {
			const joined = await create(adminId, { name: "Sales", slug: "sales" });
			await repository.addMember(workspaceId, joined.id, viewerId);

			const [seen] = await visibleTo(viewerId);
			const { leave, ...others } = seen?.permissions ?? { leave: false };

			expect(leave).toBe(true);
			expect(Object.values(others)).not.toContain(true);
		});

		it("lets a member leave a channel, and keeps an administrator in it", async () => {
			const made = await create(adminId, { name: "Sales", slug: "sales" });
			await repository.addMember(workspaceId, made.id, memberId);

			await administrationAs(memberId).leave({ channelId: made.id });

			expect((await membersOf(made.id)).map(({ userId }) => userId)).toEqual([adminId]);
			await expect(administrationAs(adminId).leave({ channelId: made.id })).rejects.toThrow(
				ActionForbidden,
			);
		});

		it("keeps a demoted administrator in their channels, with a member's permissions there", async () => {
			const made = await create(adminId, { name: "Sales", slug: "sales" });

			await onDatabase((db) =>
				db
					.update(workspaceMember)
					.set({ role: "member" })
					.where(
						and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, adminId)),
					),
			);

			const standing = await authorizationAs(adminId).channel(made.id, "channel.read");
			expect(standing.may("channel.delete")).toBe(false);
			expect(await repository.removeMember(workspaceId, made.id, adminId)).toBe("removed");
			await expect(authorizationAs(adminId).channel(made.id, "channel.read")).rejects.toThrow(
				ResourceHidden,
			);
		});

		it("does not carry an administrator's reach into another workspace", async () => {
			// Ada administers both, so the only thing keeping her out of the other
			// one's channels would be the id, which is exactly what must not be true.
			const here = await create(adminId, { name: "Sales", slug: "sales" });
			const there = await createIn(otherWorkspaceId, adminId, {
				name: "Sales",
				slug: "sales",
				visibility: "private",
			});

			expect(await visibleTo(adminId)).toEqual([expect.objectContaining({ id: here.id })]);
			await expect(authorizationAs(outsiderId).channel(here.id, "channel.read")).rejects.toThrow(
				ResourceHidden,
			);
			expect((await visibleTo(outsiderId, otherWorkspaceId)).length).toBe(0);
			expect(there.workspaceId).toBe(otherWorkspaceId);
		});

		it("gives nothing to somebody outside the workspace", async () => {
			const made = await create(adminId, { name: "Suga", slug: "suga" });

			await expect(authorizationAs(outsiderId).channel(made.id, "channel.read")).rejects.toThrow(
				ResourceHidden,
			);
		});

		it("answers no to ids that are not uuids rather than raising", async () => {
			await expect(
				authorizationAs(adminId).workspace("nonsense", "workspace.read"),
			).rejects.toThrow(ResourceHidden);
			await expect(authorizationAs(adminId).channel("nonsense", "channel.read")).rejects.toThrow(
				ResourceHidden,
			);
		});
	});

	describe("refusals, decided in the administration", () => {
		it("refuses a command to somebody who may not make it, whoever called it", async () => {
			// No route and no middleware in front: this is what a new entry point
			// that forgot to check would reach.
			const made = await create(adminId, { name: "Sales", slug: "sales" });
			await repository.addMember(workspaceId, made.id, memberId);

			await expect(administrationAs(memberId).remove({ channelId: made.id })).rejects.toThrow(
				ActionForbidden,
			);
			await expect(
				administrationAs(memberId).update({ channelId: made.id, changes: { name: "Ours" } }),
			).rejects.toThrow(ActionForbidden);
			await expect(create(viewerId, { name: "Mine", slug: "mine" })).rejects.toThrow(
				ActionForbidden,
			);
			expect(await listedTo(viewerId)).toEqual([{ id: made.id, isMember: false }]);
		});

		it("hides a channel from somebody who is not in it, whatever they asked", async () => {
			const made = await create(adminId, { name: "Sales", slug: "sales", visibility: "private" });

			await expect(
				administrationAs(memberId).update({ channelId: made.id, changes: { name: "Ours" } }),
			).rejects.toThrow(ResourceHidden);
			await expect(administrationAs(outsiderId).members({ channelId: made.id })).rejects.toThrow(
				ResourceHidden,
			);
			await expect(visibleTo(outsiderId)).rejects.toThrow(ResourceHidden);
		});
	});

	describe("workspace membership lifecycle", () => {
		it("lets somebody who created a channel leave the workspace, and keeps the channel", async () => {
			const made = await create(memberId, { name: "Sales", slug: "sales" });

			await onDatabase((db) =>
				db
					.delete(workspaceMember)
					.where(
						and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, memberId)),
					),
			);

			const [survivor] = await onDatabase((db) =>
				db.select().from(channel).where(eq(channel.id, made.id)),
			);
			expect(survivor).toMatchObject({ id: made.id });
		});
	});
});
