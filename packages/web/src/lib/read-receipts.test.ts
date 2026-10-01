import type { AgentParticipant, Message, PersonParticipant } from "@sugabots/contracts";
import { describe, expect, it } from "vitest";
import { readReceipts } from "./read-receipts.ts";

const person = (name: string): PersonParticipant => ({
	kind: "person",
	id: crypto.randomUUID(),
	name,
	handle: name.toLowerCase(),
	image: null,
});
const you = person("You");
const tom = person("Tom");
const sam = person("Sam");
const growthDesk: AgentParticipant = {
	kind: "agent",
	id: crypto.randomUUID(),
	name: "Growth Desk",
	handle: "growth-desk",
	color: "green",
	face: "pill",
};

const at = (minute: number) => `2026-10-01T09:${String(minute).padStart(2, "0")}:00.000Z`;

function said(author: Message["author"], minute: number, status: Message["status"] = "complete") {
	return {
		id: crypto.randomUUID(),
		threadId: crypto.randomUUID(),
		author,
		kind: "text",
		status,
		parts: [{ type: "text", text: "Hi" }],
		content: "Hi",
		createdAt: at(minute),
	} satisfies Message;
}

/** Who sits under each of `messages`, by name, in order. */
function faces(
	messages: Message[],
	reads: { person: PersonParticipant; minute: number }[],
	bots: AgentParticipant[] = [],
) {
	const receipts = readReceipts({
		messages,
		reads: reads.map(({ person: reader, minute }) => ({ person: reader, readThrough: at(minute) })),
		bots,
		userId: you.id,
	});
	return messages.map(
		(message) => receipts.get(message.id)?.map(({ reader }) => reader.name) ?? [],
	);
}

describe("read receipts", () => {
	it("puts each reader under the last message they have read", () => {
		const messages = [said(growthDesk, 1), said(you, 2), said(you, 3)];
		expect(
			faces(messages, [
				{ person: tom, minute: 1 },
				{ person: sam, minute: 3 },
			]),
		).toEqual([["Tom"], [], ["Sam"]]);
	});

	it("never shows you your own face", () => {
		expect(faces([said(growthDesk, 1)], [{ person: you, minute: 1 }])).toEqual([[]]);
	});

	it("shows nobody under their own message, since writing it says they read that far", () => {
		const messages = [said(growthDesk, 1), said(tom, 2), said(you, 3)];
		expect(faces(messages, [{ person: tom, minute: 2 }])).toEqual([[], [], []]);
	});

	it("puts a bot under the latest message, unless it wrote it", () => {
		expect(faces([said(you, 1), said(growthDesk, 2)], [], [growthDesk])).toEqual([[], []]);
		expect(faces([said(growthDesk, 1), said(you, 2)], [], [growthDesk])).toEqual([
			[],
			["Growth Desk"],
		]);
	});

	it("keeps a bot under the message it is answering until its reply is finished", () => {
		const writing = [said(you, 1), said(growthDesk, 2, "streaming")];
		expect(faces(writing, [], [growthDesk])).toEqual([["Growth Desk"], []]);
		const finished = [said(you, 1), said(growthDesk, 2)];
		expect(faces(finished, [], [growthDesk])).toEqual([[], []]);
	});

	it("does not count a reply still being written as read", () => {
		const messages = [said(you, 1), said(growthDesk, 2, "streaming")];
		expect(faces(messages, [{ person: tom, minute: 5 }])).toEqual([["Tom"], []]);
	});

	it("shows nobody who read only messages before the ones shown", () => {
		expect(faces([said(you, 5)], [{ person: tom, minute: 1 }])).toEqual([[]]);
	});

	it("puts the bots first, then people in the order they read", () => {
		const messages = [said(you, 1)];
		expect(
			faces(
				messages,
				[
					{ person: sam, minute: 4 },
					{ person: tom, minute: 2 },
				],
				[growthDesk],
			),
		).toEqual([["Growth Desk", "Tom", "Sam"]]);
	});
});
