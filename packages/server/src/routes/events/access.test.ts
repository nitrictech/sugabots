import { handleFromName } from "@sugabots/contracts";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import {
	agent,
	pod,
	podMember,
	thread,
	user,
	workspace,
	workspaceMember,
} from "@sugabots/core/database/schema";
import { closeDatabase, onDatabase, runOnPostgres } from "@sugabots/core/database/testing";
import { onPostgresAs } from "@sugabots/core/workspaces/testing";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { closedChannelAccess } from "./access.test-support.ts";
import { ChannelAccess } from "./access.ts";

/**
 * Who may listen to what. The workspace half is a membership query, so it needs
 * a migrated database and skips without one, as `db/schema.test.ts` does.
 */

/** The access with its answers run as `userId`, with nothing else to reach. */
function asSomebody(access: ChannelAccess.Interface, userId: string) {
	const asThem = CurrentActor.provide(CurrentActor.AuthenticatedUserId.vouchedFor(userId));
	return {
		workspace: (id: string) => Effect.runPromise(access.workspace(id).pipe(asThem)),
		thread: (id: string) => Effect.runPromise(access.thread(id).pipe(asThem)),
	};
}

it("denies event access when no access dependency is configured", async () => {
	const { workspace, thread } = asSomebody(closedChannelAccess, crypto.randomUUID());

	expect(await workspace("w1")).toBeUndefined();
	expect(await thread("c1")).toBeUndefined();
});

describe.skipIf(!process.env.DATABASE_URL)("database access", () => {
	afterAll(closeDatabase);

	/**
	 * A workspace with a member in a channel, an administrator the database has
	 * put in it too, another member outside the channel, and one person left
	 * outside the workspace.
	 */
	async function fixture() {
		const suffix = crypto.randomUUID();

		const [member] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Member", email: `member-${suffix}@example.com` })
				.returning(),
		);
		const [outsider] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Outsider", email: `outsider-${suffix}@example.com` })
				.returning(),
		);
		const [administrator] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Admin", email: `admin-${suffix}@example.com` })
				.returning(),
		);
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: "Test", slug: `test-${suffix}` })
				.returning(),
		);

		if (!member || !outsider || !administrator || !space) {
			throw new Error("fixture did not insert");
		}

		await onDatabase((db) =>
			db.insert(workspaceMember).values([
				{ workspaceId: space.id, userId: member.id },
				{ workspaceId: space.id, userId: administrator.id, role: "admin" },
			]),
		);

		// A task with a public bot, one with a private bot the member made, and
		// a thread in a channel the member is in.
		const [publicBot, privateBot] = await onDatabase((db) =>
			db
				.insert(agent)
				.values(
					(["public", "private"] as const).map((visibility) => ({
						workspaceId: space.id,
						name: `Host ${visibility} ${suffix}`,
						handle: handleFromName(`Host ${visibility} ${suffix}`),
						visibility,
						color: "rose" as const,
						face: "pill" as const,
						model: "m",
						createdById: member.id,
					})),
				)
				.returning(),
		);
		const [room] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId: space.id,
					name: "Room",
					slug: `room-${suffix}`,
					createdById: member.id,
				})
				.returning(),
		);
		if (!publicBot || !privateBot || !room) {
			throw new Error("fixture did not insert");
		}
		await onDatabase((db) =>
			db.insert(podMember).values({ workspaceId: space.id, podId: room.id, userId: member.id }),
		);
		const [conversation, privateTask, channelThread] = await onDatabase((db) =>
			db
				.insert(thread)
				.values([
					{
						workspaceId: space.id,
						hostAgentId: publicBot.id,
						type: "conversation",
						title: "A task",
						initiatorUserId: member.id,
					},
					{
						workspaceId: space.id,
						hostAgentId: privateBot.id,
						type: "conversation",
						title: "A private task",
						initiatorUserId: member.id,
					},
					{
						workspaceId: space.id,
						podId: room.id,
						type: "pod_chat",
						title: "A thread",
					},
				])
				.returning(),
		);
		if (!conversation || !privateTask || !channelThread) {
			throw new Error("fixture did not insert");
		}
		const [elsewhere] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Elsewhere", email: `elsewhere-${suffix}@example.com` })
				.returning(),
		);
		if (!elsewhere) throw new Error("fixture did not insert");
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId: space.id, userId: elsewhere.id }),
		);
		// A private bot of somebody outside the channel, asked from it, and the
		// public bot asked from the member's private task.
		const [elsewhereBot] = await onDatabase((db) =>
			db
				.insert(agent)
				.values({
					workspaceId: space.id,
					name: `Elsewhere's ${suffix}`,
					handle: handleFromName(`Elsewhere's ${suffix}`),
					visibility: "private",
					color: "rose",
					face: "pill",
					model: "m",
					createdById: elsewhere.id,
				})
				.returning(),
		);
		if (!elsewhereBot) throw new Error("fixture did not insert");
		const [askedFromChannel, askedFromPrivateTask] = await onDatabase((db) =>
			db
				.insert(thread)
				.values([
					{
						workspaceId: space.id,
						hostAgentId: elsewhereBot.id,
						conversationId: channelThread.id,
						parentThreadId: channelThread.id,
						type: "collaboration",
						title: "Asked from the channel",
					},
					{
						workspaceId: space.id,
						hostAgentId: publicBot.id,
						conversationId: privateTask.id,
						parentThreadId: privateTask.id,
						type: "collaboration",
						title: "Asked from a private task",
					},
				])
				.returning(),
		);
		if (!askedFromChannel || !askedFromPrivateTask) throw new Error("fixture did not insert");

		// The real services, over the real database, since that is what the
		// visibility joins are being checked against.
		const channels = await runOnPostgres(
			Effect.provide(ChannelAccess.Service, ChannelAccess.layer),
		);
		return {
			/** The channels `userId` is given. */
			access: (userId: string) => onPostgresAs(userId)(channels),
			member,
			administrator,
			outsider,
			elsewhere,
			space,
			room,
			conversation,
			privateTask,
			channelThread,
			askedFromChannel,
			askedFromPrivateTask,
		};
	}

	it("gives a member the workspace channel", async () => {
		const { access, member, space } = await fixture();

		expect(await access(member.id).workspace(space.id)).toBe(`workspace:${space.id}`);
	});

	it("gives a member the same channel when the workspace is named by its slug", async () => {
		const { access, member, space } = await fixture();

		expect(await access(member.id).workspace(space.slug)).toBe(`workspace:${space.id}`);
	});

	it("gives someone who is not a member nothing", async () => {
		const { access, outsider, space } = await fixture();

		expect(await access(outsider.id).workspace(space.id)).toBeUndefined();
		expect(await access(outsider.id).workspace(space.slug)).toBeUndefined();
	});

	it("gives nothing for a workspace that does not exist", async () => {
		const { access, member } = await fixture();

		expect(await access(member.id).workspace(crypto.randomUUID())).toBeUndefined();
	});

	it("gives nothing for a slug that names no workspace, rather than raising on it", async () => {
		const { access, member } = await fixture();

		expect(await access(member.id).workspace("not-a-uuid")).toBeUndefined();
	});

	it("gives a member a public bot's task's channel", async () => {
		const { access, elsewhere, conversation } = await fixture();

		expect(await access(elsewhere.id).thread(conversation.id)).toBe(`thread:${conversation.id}`);
	});

	it("gives someone outside the workspace nothing for its tasks", async () => {
		const { access, outsider, conversation } = await fixture();

		expect(await access(outsider.id).thread(conversation.id)).toBeUndefined();
	});

	it("gives nothing for a thread that does not exist", async () => {
		const { access, member } = await fixture();

		expect(await access(member.id).thread(crypto.randomUUID())).toBeUndefined();
	});

	it("lets every member hear the workspace's events about a public bot's task", async () => {
		const { access, member, elsewhere, outsider, conversation } = await fixture();

		expect(await access(member.id).hears(threadAudience(conversation.id))).toBe(true);
		expect(await access(elsewhere.id).hears(threadAudience(conversation.id))).toBe(true);
		expect(await access(outsider.id).hears(threadAudience(conversation.id))).toBe(false);
	});

	it("lets only a private bot's creator hear about its tasks, not an administrator", async () => {
		const { access, member, administrator, elsewhere, privateTask } = await fixture();

		expect(await access(member.id).hears(threadAudience(privateTask.id))).toBe(true);
		expect(await access(administrator.id).hears(threadAudience(privateTask.id))).toBe(false);
		expect(await access(elsewhere.id).hears(threadAudience(privateTask.id))).toBe(false);
	});

	it("lets only the people in a channel hear about its threads", async () => {
		const { access, member, administrator, elsewhere, space, channelThread } = await fixture();

		expect(await access(member.id).hears(threadAudience(channelThread.id))).toBe(true);
		expect(await access(administrator.id).hears(threadAudience(channelThread.id))).toBe(true);
		expect(await access(elsewhere.id).workspace(space.id)).toBe(`workspace:${space.id}`);
		expect(await access(elsewhere.id).hears(threadAudience(channelThread.id))).toBe(false);
	});

	it("keeps a collaboration with the conversation it was opened from, not the bot asked", async () => {
		const { access, member, elsewhere, askedFromPrivateTask } = await fixture();

		expect(await access(member.id).thread(askedFromPrivateTask.id)).toBe(
			`thread:${askedFromPrivateTask.id}`,
		);
		expect(await access(member.id).hears(threadAudience(askedFromPrivateTask.id))).toBe(true);
		// Everyone reaches the public bot that was asked, but not the private task.
		expect(await access(elsewhere.id).thread(askedFromPrivateTask.id)).toBeUndefined();
		expect(await access(elsewhere.id).hears(threadAudience(askedFromPrivateTask.id))).toBe(false);
	});

	it("shows the channel a collaboration with a private bot opened from it", async () => {
		const { access, member, administrator, elsewhere, askedFromChannel } = await fixture();

		expect(await access(member.id).thread(askedFromChannel.id)).toBe(
			`thread:${askedFromChannel.id}`,
		);
		expect(await access(administrator.id).hears(threadAudience(askedFromChannel.id))).toBe(true);
		// The private bot's creator is not in the channel.
		expect(await access(elsewhere.id).thread(askedFromChannel.id)).toBeUndefined();
		expect(await access(elsewhere.id).hears(threadAudience(askedFromChannel.id))).toBe(false);
	});

	it("gives an administrator without a row in the channel nothing, since reach is the row", async () => {
		const { access, administrator, room, channelThread } = await fixture();
		await onDatabase((db) =>
			db
				.delete(podMember)
				.where(and(eq(podMember.podId, room.id), eq(podMember.userId, administrator.id))),
		);

		expect(await access(administrator.id).thread(channelThread.id)).toBeUndefined();
	});
});

/** Who hears what is said of the thread `threadId`. */
function threadAudience(threadId: string) {
	return { kind: "thread" as const, threadId };
}
