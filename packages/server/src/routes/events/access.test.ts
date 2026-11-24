import { handleFromName } from "@sugabots/contracts";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { seedChat } from "@sugabots/core/chats/seed.test-support";
import { bot, member, membership, projectMember, workspace } from "@sugabots/core/database/schema";
import { closeDatabase, onDatabase, runOnPostgres } from "@sugabots/core/database/testing";
import { seedProject } from "@sugabots/core/workspaces/projects/seed.test-support";
import { onPostgresAs } from "@sugabots/core/workspaces/testing";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { closedStreamAccess } from "./access.test-support.ts";
import { StreamAccess } from "./access.ts";

/** Who may listen to what. The workspace half is a membership query, so it runs against Postgres. */

/** The access with its answers run as `memberId`, with nothing else to reach. */
function asSomebody(access: StreamAccess.Interface, memberId: string) {
	const asThem = CurrentActor.provide(CurrentActor.AuthenticatedMemberId.vouchedFor(memberId));
	return {
		workspace: (id: string) => Effect.runPromise(access.workspace(id).pipe(asThem)),
		chat: (id: string) => Effect.runPromise(access.chat(id).pipe(asThem)),
	};
}

it("denies event access when no access dependency is configured", async () => {
	const { workspace, chat } = asSomebody(closedStreamAccess, crypto.randomUUID());

	expect(await workspace("w1")).toBeUndefined();
	expect(await chat("c1")).toBeUndefined();
});

describe.skipIf(!process.env.DATABASE_URL)("database access", () => {
	afterAll(closeDatabase);

	/**
	 * A workspace with an editor in a project, an administrator the database has
	 * put in it too, another member in the workspace outside the project, and one
	 * member left outside the workspace.
	 */
	async function fixture() {
		const suffix = crypto.randomUUID();

		const [editor] = await onDatabase((db) =>
			db
				.insert(member)
				.values({ name: "Editor", email: `editor-${suffix}@example.com` })
				.returning(),
		);
		const [outsider] = await onDatabase((db) =>
			db
				.insert(member)
				.values({ name: "Outsider", email: `outsider-${suffix}@example.com` })
				.returning(),
		);
		const [administrator] = await onDatabase((db) =>
			db
				.insert(member)
				.values({ name: "Admin", email: `admin-${suffix}@example.com` })
				.returning(),
		);
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: "Test", slug: `test-${suffix}` })
				.returning(),
		);

		if (!editor || !outsider || !administrator || !space) {
			throw new Error("fixture did not insert");
		}

		await onDatabase((db) =>
			db.insert(membership).values([
				{ workspaceId: space.id, memberId: editor.id },
				{ workspaceId: space.id, memberId: administrator.id, role: "admin" },
			]),
		);

		// A chat with a public bot, one with a personal bot the editor made, and
		// a chat of a project the editor is in.
		const [publicBot, personalBot] = await onDatabase((db) =>
			db
				.insert(bot)
				.values(
					(["public", "personal"] as const).map((visibility) => ({
						workspaceId: space.id,
						name: `Host ${visibility} ${suffix}`,
						handle: handleFromName(`Host ${visibility} ${suffix}`),
						visibility,
						color: "rose" as const,
						eyes: "pill" as const,
						model: "m",
						createdById: editor.id,
					})),
				)
				.returning(),
		);
		const room = await onDatabase((db) =>
			seedProject(db, {
				workspaceId: space.id,
				name: "Room",
				slug: `room-${suffix}`,
				createdById: editor.id,
			}),
		);
		if (!publicBot || !personalBot || !room) {
			throw new Error("fixture did not insert");
		}
		await onDatabase((db) =>
			db
				.insert(projectMember)
				.values({ workspaceId: space.id, projectId: room.id, memberId: editor.id }),
		);
		const chat = await onDatabase((db) =>
			seedChat(db, {
				workspaceId: space.id,
				kind: "project_chat",
				botId: publicBot.id,
				title: "A chat",
				startedById: editor.id,
			}),
		);
		const personalBotChat = await onDatabase((db) =>
			seedChat(db, {
				workspaceId: space.id,
				kind: "project_chat",
				botId: personalBot.id,
				title: "A personal bot's chat",
				startedById: editor.id,
			}),
		);
		const projectChat = await onDatabase((db) =>
			seedChat(db, {
				workspaceId: space.id,
				kind: "project_chat",
				projectId: room.id,
				title: "A chat",
				startedById: editor.id,
			}),
		);
		const [elsewhere] = await onDatabase((db) =>
			db
				.insert(member)
				.values({ name: "Elsewhere", email: `elsewhere-${suffix}@example.com` })
				.returning(),
		);
		if (!elsewhere) throw new Error("fixture did not insert");
		await onDatabase((db) =>
			db.insert(membership).values({ workspaceId: space.id, memberId: elsewhere.id }),
		);
		// The real services, over the real database, since that is what the
		// visibility joins are being checked against.
		const streams = await runOnPostgres(Effect.provide(StreamAccess.Service, StreamAccess.layer));
		return {
			/** The streams `memberId` is given. */
			access: (memberId: string) => onPostgresAs(memberId)(streams),
			editor,
			administrator,
			outsider,
			elsewhere,
			space,
			room,
			chat,
			personalBotChat,
			projectChat,
		};
	}

	it("gives someone in the workspace its stream", async () => {
		const { access, editor, space } = await fixture();

		expect(await access(editor.id).workspace(space.id)).toBe(`workspace:${space.id}`);
	});

	it("gives someone in the workspace the same stream when it is named by its slug", async () => {
		const { access, editor, space } = await fixture();

		expect(await access(editor.id).workspace(space.slug)).toBe(`workspace:${space.id}`);
	});

	it("gives someone outside the workspace nothing", async () => {
		const { access, outsider, space } = await fixture();

		expect(await access(outsider.id).workspace(space.id)).toBeUndefined();
		expect(await access(outsider.id).workspace(space.slug)).toBeUndefined();
	});

	it("gives nothing for a workspace that does not exist", async () => {
		const { access, editor } = await fixture();

		expect(await access(editor.id).workspace(crypto.randomUUID())).toBeUndefined();
	});

	it("gives nothing for a slug that names no workspace, rather than raising on it", async () => {
		const { access, editor } = await fixture();

		expect(await access(editor.id).workspace("not-a-uuid")).toBeUndefined();
	});

	it("gives someone in the workspace a public bot's chat's stream", async () => {
		const { access, elsewhere, chat } = await fixture();

		expect(await access(elsewhere.id).chat(chat.id)).toBe(`chat:${chat.id}`);
	});

	it("gives someone outside the workspace nothing for its chats", async () => {
		const { access, outsider, chat } = await fixture();

		expect(await access(outsider.id).chat(chat.id)).toBeUndefined();
	});

	it("gives nothing for a chat that does not exist", async () => {
		const { access, editor } = await fixture();

		expect(await access(editor.id).chat(crypto.randomUUID())).toBeUndefined();
	});

	it("lets everyone in the workspace hear the workspace's events about a public bot's chat", async () => {
		const { access, editor, elsewhere, outsider, chat } = await fixture();

		expect(await access(editor.id).hears(chatAudience(chat.id))).toBe(true);
		expect(await access(elsewhere.id).hears(chatAudience(chat.id))).toBe(true);
		expect(await access(outsider.id).hears(chatAudience(chat.id))).toBe(false);
	});

	it("lets only a personal bot's creator hear about its chats, not an administrator", async () => {
		const { access, editor, administrator, elsewhere, personalBotChat } = await fixture();

		expect(await access(editor.id).hears(chatAudience(personalBotChat.id))).toBe(true);
		expect(await access(administrator.id).hears(chatAudience(personalBotChat.id))).toBe(false);
		expect(await access(elsewhere.id).hears(chatAudience(personalBotChat.id))).toBe(false);
	});

	it("lets only the members in a project hear about its chats", async () => {
		const { access, editor, administrator, elsewhere, space, projectChat } = await fixture();

		expect(await access(editor.id).hears(chatAudience(projectChat.id))).toBe(true);
		expect(await access(administrator.id).hears(chatAudience(projectChat.id))).toBe(true);
		expect(await access(elsewhere.id).workspace(space.id)).toBe(`workspace:${space.id}`);
		expect(await access(elsewhere.id).hears(chatAudience(projectChat.id))).toBe(false);
	});

	it("gives an administrator without a row in the project nothing, since reach is the row", async () => {
		const { access, administrator, room, projectChat } = await fixture();
		await onDatabase((db) =>
			db
				.delete(projectMember)
				.where(
					and(eq(projectMember.projectId, room.id), eq(projectMember.memberId, administrator.id)),
				),
		);

		expect(await access(administrator.id).chat(projectChat.id)).toBeUndefined();
	});
});

/** Who hears what is said of the chat `chatId`. */
function chatAudience(chatId: string) {
	return { kind: "chat" as const, chatId };
}
