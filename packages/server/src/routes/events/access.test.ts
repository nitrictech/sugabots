import { handleFromName } from "@sugabots/contracts";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { seedChat } from "@sugabots/core/chats/seed.test-support";
import {
	bot,
	membership,
	message,
	person,
	projectMember,
	turn,
	workspace,
} from "@sugabots/core/database/schema";
import { closeDatabase, onDatabase, runOnPostgres } from "@sugabots/core/database/testing";
import { seedProject } from "@sugabots/core/workspaces/projects/seed.test-support";
import { onPostgresAs } from "@sugabots/core/workspaces/testing";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { closedStreamAccess } from "./access.test-support.ts";
import { StreamAccess } from "./access.ts";

/** Who may listen to what. The workspace half is a membership query, so it runs against Postgres. */

/** The access with its answers run as `personId`, with nothing else to reach. */
function asSomebody(access: StreamAccess.Interface, personId: string) {
	const asThem = CurrentActor.provide(CurrentActor.AuthenticatedPersonId.vouchedFor(personId));
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
	 * put in it too, another person in the workspace outside the project, and one
	 * person left outside the workspace.
	 */
	async function fixture() {
		const suffix = crypto.randomUUID();

		const [editor] = await onDatabase((db) =>
			db
				.insert(person)
				.values({ name: "Editor", email: `editor-${suffix}@example.com` })
				.returning(),
		);
		const [outsider] = await onDatabase((db) =>
			db
				.insert(person)
				.values({ name: "Outsider", email: `outsider-${suffix}@example.com` })
				.returning(),
		);
		const [administrator] = await onDatabase((db) =>
			db
				.insert(person)
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
				{ workspaceId: space.id, personId: editor.id },
				{ workspaceId: space.id, personId: administrator.id, role: "admin" },
			]),
		);

		// A chat with a public bot, one with a private bot the editor made, and
		// a chat of a project the editor is in.
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
		if (!publicBot || !privateBot || !room) {
			throw new Error("fixture did not insert");
		}
		await onDatabase((db) =>
			db
				.insert(projectMember)
				.values({ workspaceId: space.id, projectId: room.id, personId: editor.id }),
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
		const privateChat = await onDatabase((db) =>
			seedChat(db, {
				workspaceId: space.id,
				kind: "project_chat",
				botId: privateBot.id,
				title: "A private chat",
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
				.insert(person)
				.values({ name: "Elsewhere", email: `elsewhere-${suffix}@example.com` })
				.returning(),
		);
		if (!elsewhere) throw new Error("fixture did not insert");
		await onDatabase((db) =>
			db.insert(membership).values({ workspaceId: space.id, personId: elsewhere.id }),
		);
		// A private bot of somebody outside the project, asked from it, and the
		// public bot asked from the editor's private chat.
		const [elsewhereBot] = await onDatabase((db) =>
			db
				.insert(bot)
				.values({
					workspaceId: space.id,
					name: `Elsewhere's ${suffix}`,
					handle: handleFromName(`Elsewhere's ${suffix}`),
					visibility: "private",
					color: "rose",
					eyes: "pill",
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
						chatId: askedFromId,
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
						chatId: askedFromId,
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
				seedChat(db, {
					workspaceId: space.id,
					kind: "collaboration",
					title,
					collaboration: {
						parentChatId: askedFromId,
						rootChatId: askedFromId,
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
			projectChat.id,
			publicBot.id,
			elsewhereBot.id,
			"Asked from the project",
		);
		const askedFromPrivateChat = await askedFrom(
			privateChat.id,
			privateBot.id,
			publicBot.id,
			"Asked from a private chat",
		);

		// The real services, over the real database, since that is what the
		// visibility joins are being checked against.
		const streams = await runOnPostgres(Effect.provide(StreamAccess.Service, StreamAccess.layer));
		return {
			/** The streams `personId` is given. */
			access: (personId: string) => onPostgresAs(personId)(streams),
			editor,
			administrator,
			outsider,
			elsewhere,
			space,
			room,
			chat,
			privateChat,
			projectChat,
			askedFromProject,
			askedFromPrivateChat,
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

	it("lets only a private bot's creator hear about its chats, not an administrator", async () => {
		const { access, editor, administrator, elsewhere, privateChat } = await fixture();

		expect(await access(editor.id).hears(chatAudience(privateChat.id))).toBe(true);
		expect(await access(administrator.id).hears(chatAudience(privateChat.id))).toBe(false);
		expect(await access(elsewhere.id).hears(chatAudience(privateChat.id))).toBe(false);
	});

	it("lets only the people in a project hear about its chats", async () => {
		const { access, editor, administrator, elsewhere, space, projectChat } = await fixture();

		expect(await access(editor.id).hears(chatAudience(projectChat.id))).toBe(true);
		expect(await access(administrator.id).hears(chatAudience(projectChat.id))).toBe(true);
		expect(await access(elsewhere.id).workspace(space.id)).toBe(`workspace:${space.id}`);
		expect(await access(elsewhere.id).hears(chatAudience(projectChat.id))).toBe(false);
	});

	it("keeps a collaboration with the chat it was opened from, not the bot asked", async () => {
		const { access, editor, elsewhere, askedFromPrivateChat } = await fixture();

		expect(await access(editor.id).chat(askedFromPrivateChat.id)).toBe(
			`chat:${askedFromPrivateChat.id}`,
		);
		expect(await access(editor.id).hears(chatAudience(askedFromPrivateChat.id))).toBe(true);
		// Everyone reaches the public bot that was asked, but not the private chat.
		expect(await access(elsewhere.id).chat(askedFromPrivateChat.id)).toBeUndefined();
		expect(await access(elsewhere.id).hears(chatAudience(askedFromPrivateChat.id))).toBe(false);
	});

	it("shows the project a collaboration with a private bot opened from it", async () => {
		const { access, editor, administrator, elsewhere, askedFromProject } = await fixture();

		expect(await access(editor.id).chat(askedFromProject.id)).toBe(`chat:${askedFromProject.id}`);
		expect(await access(administrator.id).hears(chatAudience(askedFromProject.id))).toBe(true);
		// The private bot's creator is not in the project.
		expect(await access(elsewhere.id).chat(askedFromProject.id)).toBeUndefined();
		expect(await access(elsewhere.id).hears(chatAudience(askedFromProject.id))).toBe(false);
	});

	it("gives an administrator without a row in the project nothing, since reach is the row", async () => {
		const { access, administrator, room, projectChat } = await fixture();
		await onDatabase((db) =>
			db
				.delete(projectMember)
				.where(
					and(eq(projectMember.projectId, room.id), eq(projectMember.personId, administrator.id)),
				),
		);

		expect(await access(administrator.id).chat(projectChat.id)).toBeUndefined();
	});
});

/** Who hears what is said of the chat `chatId`. */
function chatAudience(chatId: string) {
	return { kind: "chat" as const, chatId };
}
