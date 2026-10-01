import type { Message } from "@sugabots/contracts";

/**
 * The ids of people's messages that wait for an agent's next reply: those
 * posted since `queuedSince`, when a turn asked for while the agent was still
 * answering started waiting. That turn reads them all once it starts, so they
 * are answered together. The server decides what waits, so a message that
 * asked for no reply, posted before then, does not.
 */
export function queuedBehindReply(
	messages: readonly Message[],
	queuedSince: string | null,
): ReadonlySet<string> {
	if (queuedSince === null) return new Set();
	const since = Date.parse(queuedSince);
	return new Set(
		messages
			.filter(
				(message) => message.author.kind === "person" && Date.parse(message.createdAt) >= since,
			)
			.map((message) => message.id),
	);
}
