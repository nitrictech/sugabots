import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { bot, placedChat, project } from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import { named } from "../proofs/proof.ts";
import { proveReachesBot } from "../proofs/reaches-bot.ts";
import { proveReachesChat } from "../proofs/reaches-chat.ts";
import { proveReachesProject } from "../proofs/reaches-project.ts";
import { authenticators, buildWorld, principals } from "../proofs/world.test-support.ts";
import { reachesBotFor, reachesChatFor, reachesProjectFor } from "./access.ts";

describe("reach written as SQL", () => {
	afterAll(async () => {
		await closeDatabase();
	});

	it("agrees with the member reach provers for bots, projects and chats", async () => {
		const { a, b } = await buildWorld();
		await onDatabase((db) =>
			db.update(project).set({ deleting: true }).where(eq(project.id, a.helper.defaultProject)),
		);
		const as = principals(await authenticators());
		const editor = await as.member(a.ed);
		const viewer = await as.member(a.vi);
		const outsider = await as.member(a.erin);
		const cases = [
			{
				member: editor,
				botId: a.pub.id,
				projectId: a.project,
				chatId: a.chat,
				expected: [true, true, true],
			},
			{
				member: viewer,
				botId: a.pub.id,
				projectId: a.pub.defaultProject,
				chatId: a.pubChat,
				expected: [true, true, true],
			},
			{
				member: outsider,
				botId: a.pub.id,
				projectId: a.project,
				chatId: a.chat,
				expected: [true, false, false],
			},
			{
				member: viewer,
				botId: a.personal.id,
				projectId: a.assistant.defaultProject,
				chatId: a.assistantChat,
				expected: [false, false, false],
			},
			{
				member: viewer,
				botId: a.assistant.id,
				projectId: a.assistant.defaultProject,
				chatId: a.assistantChat,
				expected: [false, false, false],
			},
			{
				member: editor,
				botId: a.system.id,
				projectId: a.project,
				chatId: a.chat,
				expected: [false, true, true],
			},
			{
				member: editor,
				botId: a.assistant.id,
				projectId: a.assistant.defaultProject,
				chatId: a.assistantChat,
				expected: [true, true, true],
			},
			{
				member: editor,
				botId: a.helper.id,
				projectId: a.otherProject,
				chatId: a.otherChat,
				expected: [false, true, true],
			},
			{
				member: viewer,
				botId: b.bot.id,
				projectId: b.project,
				chatId: b.chat,
				expected: [false, false, false],
			},
		];

		for (const { member, botId, projectId, chatId, expected } of cases) {
			const [row] = await onDatabase((db) =>
				db
					.select({
						bot: reachesBotFor(bot.id, member.member),
						project: reachesProjectFor(project.id, member.member),
						chat: reachesChatFor(placedChat, member.member),
					})
					.from(bot)
					.innerJoin(project, eq(project.id, projectId))
					.innerJoin(placedChat, eq(placedChat.id, chatId))
					.where(eq(bot.id, botId)),
			);
			const proved = await named(member, botId, projectId, chatId, (member, bot, project, chat) =>
				Effect.all([
					proveReachesBot(member, bot).pipe(
						Effect.as(true),
						Effect.catchTag("ResourceHidden", () => Effect.succeed(false)),
					),
					proveReachesProject(member, project).pipe(
						Effect.as(true),
						Effect.catchTag("ResourceHidden", () => Effect.succeed(false)),
					),
					proveReachesChat(member, chat).pipe(
						Effect.as(true),
						Effect.catchTag("ResourceHidden", () => Effect.succeed(false)),
					),
				]),
			).pipe(runOnPostgres);
			expect(proved).toEqual(expected);
			expect([row?.bot, row?.project, row?.chat]).toEqual(proved);
		}
	});
});
