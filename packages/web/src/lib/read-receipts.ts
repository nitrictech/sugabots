import type { AgentParticipant, Message, ThreadParticipant, ThreadRead } from "@sugabots/contracts";

/** Someone who has read as far as a message, and when they did. */
export interface Receipt {
	reader: ThreadParticipant;
	readAt: string;
}

/**
 * Whose face sits under each message, by message id. Everyone's sits under
 * the last message they have read, except where that message is their own:
 * writing it says as much, so you never see your own face, and a bot that
 * replied shows none. A bot reads everything in its thread as it arrives,
 * and stays under the message it is answering until its reply is finished.
 * Someone who read only as far as messages older than `messages` shows
 * nowhere. Each row has the bots first, then people in the order they read.
 */
export function readReceipts({
	messages,
	reads,
	bots,
	userId,
}: {
	messages: readonly Message[];
	reads: readonly ThreadRead[];
	/** The bots in the thread. */
	bots: readonly AgentParticipant[];
	/** Whoever is looking, who is never shown a receipt of their own. */
	userId: string;
}): ReadonlyMap<string, Receipt[]> {
	const receipts = new Map<string, Receipt[]>();
	const place = (message: Message, receipt: Receipt) => {
		if (message.author.kind !== "routine_trigger" && message.author.id === receipt.reader.id) {
			return;
		}
		receipts.set(message.id, [...(receipts.get(message.id) ?? []), receipt]);
	};

	for (const bot of bots) {
		// Until its reply is finished, it stays under what it is answering.
		const lastRead = messages.findLast(
			(message) =>
				message.status !== "streaming" ||
				message.author.kind !== "agent" ||
				message.author.id !== bot.id,
		);
		if (lastRead) place(lastRead, { reader: bot, readAt: lastRead.createdAt });
	}

	const byWhenRead = [...reads].sort(
		(left, right) => Date.parse(left.readThrough) - Date.parse(right.readThrough),
	);
	for (const { person, readThrough, readAt } of byWhenRead) {
		if (person.id === userId) continue;
		const readUpTo = Date.parse(readThrough);
		const lastRead = messages.findLast(
			// A reply still being written is not read until it is finished.
			(message) => message.status !== "streaming" && Date.parse(message.createdAt) <= readUpTo,
		);
		if (lastRead) place(lastRead, { reader: person, readAt });
	}
	return receipts;
}
