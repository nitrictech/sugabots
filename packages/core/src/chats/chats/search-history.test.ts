import type { InputOf, OutputOf } from "@sugabots/contracts/operations";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { EventBus } from "../../database/events/bus.ts";
import { EventStore } from "../../database/events/store.ts";
import { bot, chatCompaction, file, message } from "../../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../../database/testing.ts";
import { asMember } from "../../operations/chats/testing.ts";
import { servedOperations } from "../../operations/testing.ts";
import { describeAttachment } from "../store/message-text.ts";
import { chatServicesForTests } from "../testing.ts";
import { aChatAwaitingReply, openTurn, runningTurns, runOver } from "../turns/testing.ts";

import { EMPTY_HISTORY_SEARCH } from "./search-history.ts";

const FIRST_HISTORY_AT = new Date("2025-01-01T00:00:00Z");
const KEPT_FROM = new Date("2025-01-01T00:10:00Z");

function matchText(result: OutputOf<"chats.searchHistory">) {
	if ("refused" in result) throw new Error(result.refused);
	return result.messages.map(({ text }) => text);
}

describe.skipIf(!process.env.DATABASE_URL)("searching chat history, against Postgres", async () => {
	const eventStore = await runOnPostgres(EventStore.make);
	const services = await chatServicesForTests(EventBus.inProcess({ store: eventStore }));
	const call = await servedOperations({ chats: services });
	const drive = runOver(services);

	afterAll(closeDatabase);

	async function chatForSearch({ usesComputer = false } = {}) {
		const { chatId, adminId, botId } = await aChatAwaitingReply((memberId) =>
			asMember(call, memberId),
		);
		if (usesComputer) {
			await onDatabase((db) => db.update(bot).set({ usesComputer }).where(eq(bot.id, botId)));
		}
		await onDatabase((db) =>
			db.insert(chatCompaction).values({
				chatId,
				condensed: "Earlier messages",
				historyStartsAt: FIRST_HISTORY_AT,
				keptFrom: KEPT_FROM,
			}),
		);
		const [run] = await runOnPostgres(runningTurns(chatId));
		if (!run) throw new Error("The chat has no turn");
		const turn = await drive(openTurn(run));
		return {
			chatId,
			memberId: adminId,
			searchFor: (input: InputOf<"chats.searchHistory">) =>
				call(turn.principal, "chats.searchHistory", { chat: chatId, ...input }),
		};
	}

	it("searches only messages before the kept history, even when the requested range includes newer messages", async () => {
		const { chatId, memberId, searchFor } = await chatForSearch();
		const budget = "The hotel budget is 150 euros a night.";
		const beforeKept = [
			{ content: "The train leaves at noon.", createdAt: FIRST_HISTORY_AT },
			{ content: budget, createdAt: new Date("2025-01-01T00:01:00Z") },
		];
		await onDatabase((db) =>
			db.insert(message).values(
				[...beforeKept, { content: "Revised hotel budget.", createdAt: KEPT_FROM }].map(
					({ content, createdAt }) => ({
						chatId,
						authorMemberId: memberId,
						status: "complete" as const,
						parts: [{ type: "text" as const, text: content }],
						content,
						createdAt,
					}),
				),
			),
		);

		expect(await searchFor({ query: "hotel budget" })).toEqual({
			messages: [expect.objectContaining({ author: "Sam", text: budget })],
			more: false,
		});
		expect(matchText(await searchFor({ after: FIRST_HISTORY_AT.toISOString() }))).toEqual(
			beforeKept.map(({ content }) => content),
		);
		expect(
			matchText(
				await searchFor({
					after: FIRST_HISTORY_AT.toISOString(),
					before: KEPT_FROM.toISOString(),
				}),
			),
		).toEqual(beforeKept.map(({ content }) => content));
		expect(matchText(await searchFor({ after: beforeKept[1]?.createdAt.toISOString() }))).toEqual([
			budget,
		]);
	});

	it("refuses a search without words or a time range", async () => {
		const { searchFor } = await chatForSearch();

		expect(await searchFor({})).toEqual({ refused: EMPTY_HISTORY_SEARCH });
	});

	it("searches history in any language: stemmed, as written, and as substrings", async () => {
		const { chatId, memberId, searchFor } = await chatForSearch();
		const said = [
			"The hotels near the river are all booked.",
			// "was" is an English stop word, so stemmed English search drops it.
			"Was kostet das Hotel pro Nacht?",
			// No spaces between words: full-text search reads this as one token.
			"我们的酒店预算是每晚150欧元。",
			"Discount code: 50%_OFF",
			// "river" only as part of a longer word: a substring match, not a full-text one.
			"Riverside parking is free.",
		];
		await onDatabase((db) =>
			db.insert(message).values(
				said.map((content, index) => ({
					chatId: chatId,
					authorMemberId: memberId,
					status: "complete" as const,
					parts: [{ type: "text" as const, text: content }],
					content,
					createdAt: new Date(FIRST_HISTORY_AT.getTime() + index * 60_000),
				})),
			),
		);
		const found = async (query: string) => matchText(await searchFor({ query }));

		expect(await found("hotel booking")).toEqual([said[0]]);
		expect(await found("was kostet")).toEqual([said[1]]);
		expect(await found("酒店预算")).toEqual([said[2]]);
		// Wildcards the bot types are taken literally.
		expect(await found("50%_OFF")).toEqual([said[3]]);
		expect(await found("5%OFF")).toEqual([]);
		// A full-text match ranks above one found only as a substring, even a newer one.
		expect(await found("river")).toEqual([said[0], said[4]]);
	});

	it("finds the files a message carried, even one with nothing else in it", async () => {
		const { chatId, memberId, searchFor } = await chatForSearch({ usesComputer: true });
		const started = FIRST_HISTORY_AT;
		const sent = await onDatabase((db) =>
			db
				.insert(message)
				.values(
					["Here is the signed contract", ""].map((content, index) => ({
						chatId: chatId,
						authorMemberId: memberId,
						status: "complete" as const,
						parts: content ? [{ type: "text" as const, text: content }] : [],
						content,
						createdAt: new Date(started.getTime() + index * 60_000),
					})),
				)
				.returning({ id: message.id }),
		);
		const [withText, filesOnly] = sent;
		if (!withText || !filesOnly) throw new Error("Could not create the messages");
		const attached = await onDatabase((db) =>
			db
				.insert(file)
				.values(
					[
						{ messageId: withText.id, name: "contract.pdf", contentType: "application/pdf" },
						{ messageId: filesOnly.id, name: "chart.png", contentType: "image/png" },
					].map((file) => ({
						...file,
						chatId: chatId,
						kind: "attachment" as const,
						uploaderId: memberId,
						position: 0,
						size: 2048,
					})),
				)
				.returning({ id: file.id, name: file.name }),
		);
		const attachmentLine = (name: string, contentType: string) => {
			const attachedFile = attached.find((file) => file.name === name);
			if (!attachedFile) throw new Error(`Missing attachment ${name}`);
			return describeAttachment(
				{ type: "file", id: attachedFile.id, name, contentType, size: 2048 },
				{ usesComputer: true },
			);
		};

		expect(matchText(await searchFor({ query: "signed contract" }))).toEqual([
			`Here is the signed contract\n${attachmentLine("contract.pdf", "application/pdf")}`,
		]);
		const chart = attachmentLine("chart.png", "image/png");
		expect(matchText(await searchFor({ query: "chart.png" }))).toEqual([chart]);
		expect(matchText(await searchFor({ after: started.toISOString() }))).toContain(chart);
	});
});
