import type { Message } from "@sugabots/contracts";

/**
 * The ids of people's messages that wait for an agent's next reply: from
 * `queuedFrom`, the message a waiting turn was first asked for, onwards. That
 * turn reads them all once it starts, so they are answered together. The
 * server decides what waits, so a message that asked for no reply, posted
 * before it, does not.
 */
export function queuedBehindReply(
	messages: readonly Message[],
	queuedFrom: string | null,
): ReadonlySet<string> {
	if (queuedFrom === null) return new Set();
	const posted = messages.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
	const first = posted.findIndex((message) => message.id === queuedFrom);
	if (first === -1) return new Set();
	return new Set(
		posted
			.slice(first)
			.filter((message) => message.author.kind === "person")
			.map((message) => message.id),
	);
}
