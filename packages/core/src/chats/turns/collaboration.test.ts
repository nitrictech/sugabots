import { afterAll, describe, expect, it } from "vitest";
import {
	seedBot,
	seedMember,
	seedMessage,
	seedProject,
	seedProjectChat,
	seedTurn,
	seedWorkspace,
} from "../../authentication/seed.test-support.ts";
import { query } from "../../database/database.ts";
import { closeDatabase, runOnPostgres } from "../../database/testing.ts";
import { earliestAnsweredByTurnToCome } from "./collaboration.ts";

/** What a turn still to come answers, which no compaction may condense or reach past. */
describe.skipIf(!process.env.DATABASE_URL)("the earliest message a turn to come answers", () => {
	afterAll(async () => {
		await closeDatabase();
	});

	it("follows a helper of a hand-back that asked again back to the member's message that started them", async () => {
		const workspaceId = await seedWorkspace();
		const sam = await seedMember(workspaceId, "editor");
		const asker = (await seedBot(workspaceId)).id;
		const helper = (await seedBot(workspaceId)).id;
		const projectId = await seedProject(workspaceId, {
			leadBotId: asker,
			members: [sam],
			bots: [helper],
		});
		const chatId = await seedProjectChat(workspaceId, projectId, sam);
		const done = { status: "done" } as const;

		const started = await seedMessage(chatId, { member: sam });
		const answering = await seedTurn(chatId, asker, started, done);
		const asked = await seedMessage(chatId, { bot: asker, turn: answering });
		await seedTurn(chatId, helper, asked, { ...done, reason: "collaboration" });
		const handingBack = await seedTurn(chatId, asker, asked, { ...done, reason: "hand_back" });
		const askedAgain = await seedMessage(chatId, { bot: asker, turn: handingBack });
		await seedTurn(chatId, helper, askedAgain, { reason: "collaboration" });
		await seedMessage(chatId, { member: sam });

		const earliest = await runOnPostgres(query((db) => earliestAnsweredByTurnToCome(db, chatId)));

		expect(earliest?.id).toBe(started);
	});
});
