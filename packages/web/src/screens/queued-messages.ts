import type { Message } from "@sugabots/contracts";

/**
 * The ids of people's messages that wait for the agent's next reply. A turn
 * reads the thread once, as its reply starts, so whatever is posted while that
 * reply is still being written waits behind it, and the next turn answers all
 * of it together.
 */
export function queuedBehindReply(messages: readonly Message[]): ReadonlySet<string> {
	const posted = messages.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
	const writing = posted.findLastIndex(
		(message) => message.author.kind === "agent" && message.status === "streaming",
	);
	if (writing === -1) return new Set();
	return new Set(
		posted
			.slice(writing + 1)
			.filter((message) => message.author.kind === "person")
			.map((message) => message.id),
	);
}
