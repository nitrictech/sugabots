import { handleFromName } from "@sugabots/contracts";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { seedConversation } from "@sugabots/core/conversations/seed.test-support";
import {
	bot,
	message,
	project,
	projectMember,
	turn,
	user,
	workspace,
	workspaceMember,
} from "@sugabots/core/database/schema";
import { closeDatabase, onDatabase, runOnPostgres } from "@sugabots/core/database/testing";
import { onPostgresAs } from "@sugabots/core/workspaces/testing";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { closedStreamAccess } from "./access.test-support.ts";
import { StreamAccess } from "./access.ts";

/**
 * Who may listen to what. The workspace half is a membership query, so it needs
 * a migrated database and skips without one, as `db/schema.test.ts` does.
 */

/** The access with its answers run as `userId`, with nothing else to reach. */
function asSomebody(access: StreamAccess.Interface, userId: string) {
	const asThem = CurrentActor.provide(CurrentActor.AuthenticatedUserId.vouchedFor(userId));
	return {
		workspace: (id: string) => Effect.runPromise(access.workspace(id).pipe(asThem)),
		conversation: (id: string) => Effect.runPromise(access.conversation(id).pipe(asThem)),
	};
}

it("denies event access when no access dependency is configured", async () => {
	const { workspace, conversation } = asSomebody(closedStreamAccess, crypto.randomUUID());

	expect(await workspace("w1")).toBeUndefined();
	expect(await conversation("c1")).toBeUndefined();
});

describe.skipIf(!process.env.DATABASE_URL)("database access", () => {
	afterAll(closeDatabase);

	/**
	 * A workspace with a member in a project, an administrator the database has
	 * put in it too, another member outside the project, and one person left
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

		// A thread with a public bot, one with a private bot the member made, and
		// a thread of a project the member is in.
		const [publicBot, privateBot] = await onDatabase((db) =>
			db
				.insert(bot)
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
				.insert(project)
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
			db
				.insert(projectMember)
				.values({ workspaceId: space.id, projectId: room.id, userId: member.id }),
		);
		const conversation = await onDatabase((db) =>
			seedConversation(db, {
				workspaceId: space.id,
				kind: "project_thread",
				botId: publicBot.id,
				title: "A thread",
				startedById: member.id,
			}),
		);
		const privateThread = await onDatabase((db) =>
			seedConversation(db, {
				workspaceId: space.id,
				kind: "project_thread",
				botId: privateBot.id,
				title: "A private thread",
				startedById: member.id,
			}),
		);
		const projectThread = await onDatabase((db) =>
			seedConversation(db, {
				workspaceId: space.id,
				kind: "project_thread",
				projectId: room.id,
				title: "A thread",
			}),
		);
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
		// A private bot of somebody outside the project, asked from it, and the
		// public bot asked from the member's private thread.
		const [elsewhereBot] = await onDatabase((db) =>
			db
				.insert(bot)
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
		/** A collaboration `askingBotId`'s reply in `askedFrom` opened with `collaboratorBotId`. */
		const askedFrom = async (
			askedFromId: string,
			askingBotId: string,
			collaboratorBotId: string,
			title: string,
		) => {
			const [reply] = await onDatabase((db) =>
				db
					.insert(message)
					.values({
						conversationId: askedFromId,
						authorBotId: askingBotId,
						kind: "text",
						status: "complete",
						parts: [],
						content: "Asking.",
					})
					.returning(),
			);
			if (!reply) throw new Error("fixture did not insert");
			const [asking] = await onDatabase((db) =>
				db
					.insert(turn)
					.values({
						conversationId: askedFromId,
						botId: askingBotId,
						triggerMessageId: reply.id,
						status: "done",
						model: "m",
						startedAt: new Date(),
					})
					.returning(),
			);
			if (!asking) throw new Error("fixture did not insert");
			return onDatabase((db) =>
				seedConversation(db, {
					workspaceId: space.id,
					kind: "collaboration",
					title,
					collaboration: {
						parentConversationId: askedFromId,
						rootConversationId: askedFromId,
						parentMessageId: reply.id,
						turnId: asking.id,
						collaboratorBotId,
						brief: title,
						atOffset: 0,
					},
				}),
			);
		};
		const askedFromProject = await askedFrom(
			projectThread.id,
			publicBot.id,
			elsewhereBot.id,
			"Asked from the project",
		);
		const askedFromPrivateThread = await askedFrom(
			privateThread.id,
			privateBot.id,
			publicBot.id,
			"Asked from a private thread",
		);

		// The real services, over the real database, since that is what the
		// visibility joins are being checked against.
		const streams = await runOnPostgres(Effect.provide(StreamAccess.Service, StreamAccess.layer));
		return {
			/** The streams `userId` is given. */
			access: (userId: string) => onPostgresAs(userId)(streams),
			member,
			administrator,
			outsider,
			elsewhere,
			space,
			room,
			conversation,
			privateThread,
			projectThread,
			askedFromProject,
			askedFromPrivateThread,
		};
	}

	it("gives a member the workspace stream", async () => {
		const { access, member, space } = await fixture();

		expect(await access(member.id).workspace(space.id)).toBe(`workspace:${space.id}`);
	});

	it("gives a member the same stream when the workspace is named by its slug", async () => {
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

	it("gives a member a public bot's thread's stream", async () => {
		const { access, elsewhere, conversation } = await fixture();

		expect(await access(elsewhere.id).conversation(conversation.id)).toBe(
			`conversation:${conversation.id}`,
		);
	});

	it("gives someone outside the workspace nothing for its threads", async () => {
		const { access, outsider, conversation } = await fixture();

		expect(await access(outsider.id).conversation(conversation.id)).toBeUndefined();
	});

	it("gives nothing for a conversation that does not exist", async () => {
		const { access, member } = await fixture();

		expect(await access(member.id).conversation(crypto.randomUUID())).toBeUndefined();
	});

	it("lets every member hear the workspace's events about a public bot's thread", async () => {
		const { access, member, elsewhere, outsider, conversation } = await fixture();

		expect(await access(member.id).hears(conversationAudience(conversation.id))).toBe(true);
		expect(await access(elsewhere.id).hears(conversationAudience(conversation.id))).toBe(true);
		expect(await access(outsider.id).hears(conversationAudience(conversation.id))).toBe(false);
	});

	it("lets only a private bot's creator hear about its threads, not an administrator", async () => {
		const { access, member, administrator, elsewhere, privateThread } = await fixture();

		expect(await access(member.id).hears(conversationAudience(privateThread.id))).toBe(true);
		expect(await access(administrator.id).hears(conversationAudience(privateThread.id))).toBe(
			false,
		);
		expect(await access(elsewhere.id).hears(conversationAudience(privateThread.id))).toBe(false);
	});

	it("lets only the people in a project hear about its threads", async () => {
		const { access, member, administrator, elsewhere, space, projectThread } = await fixture();

		expect(await access(member.id).hears(conversationAudience(projectThread.id))).toBe(true);
		expect(await access(administrator.id).hears(conversationAudience(projectThread.id))).toBe(true);
		expect(await access(elsewhere.id).workspace(space.id)).toBe(`workspace:${space.id}`);
		expect(await access(elsewhere.id).hears(conversationAudience(projectThread.id))).toBe(false);
	});

	it("keeps a collaboration with the conversation it was opened from, not the bot asked", async () => {
		const { access, member, elsewhere, askedFromPrivateThread } = await fixture();

		expect(await access(member.id).conversation(askedFromPrivateThread.id)).toBe(
			`conversation:${askedFromPrivateThread.id}`,
		);
		expect(await access(member.id).hears(conversationAudience(askedFromPrivateThread.id))).toBe(
			true,
		);
		// Everyone reaches the public bot that was asked, but not the private thread.
		expect(await access(elsewhere.id).conversation(askedFromPrivateThread.id)).toBeUndefined();
		expect(await access(elsewhere.id).hears(conversationAudience(askedFromPrivateThread.id))).toBe(
			false,
		);
	});

	it("shows the project a collaboration with a private bot opened from it", async () => {
		const { access, member, administrator, elsewhere, askedFromProject } = await fixture();

		expect(await access(member.id).conversation(askedFromProject.id)).toBe(
			`conversation:${askedFromProject.id}`,
		);
		expect(await access(administrator.id).hears(conversationAudience(askedFromProject.id))).toBe(
			true,
		);
		// The private bot's creator is not in the project.
		expect(await access(elsewhere.id).conversation(askedFromProject.id)).toBeUndefined();
		expect(await access(elsewhere.id).hears(conversationAudience(askedFromProject.id))).toBe(false);
	});

	it("gives an administrator without a row in the project nothing, since reach is the row", async () => {
		const { access, administrator, room, projectThread } = await fixture();
		await onDatabase((db) =>
			db
				.delete(projectMember)
				.where(
					and(eq(projectMember.projectId, room.id), eq(projectMember.userId, administrator.id)),
				),
		);

		expect(await access(administrator.id).conversation(projectThread.id)).toBeUndefined();
	});
});

/** Who hears what is said of the conversation `conversationId`. */
function conversationAudience(conversationId: string) {
	return { kind: "conversation" as const, conversationId };
}
