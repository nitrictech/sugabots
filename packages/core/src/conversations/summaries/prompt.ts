import type { Models } from "../../providers/models/models.ts";
import type { PreparedBotSummary, PreparedSummary } from "./summaries.ts";

/** What the prompt reads. Narrower than a `PreparedSummary` so a model trial can build one. */
export type SummaryPromptInput = Pick<
	PreparedSummary,
	"workspaceId" | "model" | "conversationTitle" | "previousContent" | "transcript"
>;

export function conversationSummaryPrompt(prepared: SummaryPromptInput): Models.Prompt {
	const previous = prepared.previousContent
		? `Previous summary:\n${prepared.previousContent}`
		: "There is no previous summary.";
	const transcript = prepared.transcript
		.map((entry) => `${entry.author} (${entry.kind}): ${entry.content}`)
		.join("\n\n");

	return {
		workspaceId: prepared.workspaceId,
		model: prepared.model,
		system: [
			"Write a compact conversation summary containing only durable context needed to continue the work.",
			"Keep confirmed facts, decisions, results, unresolved questions, owners, and the immediate next step. Omit conversational back-and-forth, acknowledgements, apologies, superseded corrections, and repeated details.",
			prepared.previousContent
				? "The transcript includes recent overlap with the previous summary. Treat the transcript as authoritative and correct any conflict. Return plain prose only, with no heading, no bullets, and no more than 50 words. Do not invent details."
				: [
						"This is the first completed exchange. Return strict JSON with exactly two string fields: title and summary.",
						"The title must describe the actual work, contain no surrounding quotes or invented identifiers, and be at most 80 characters.",
						"The summary must be plain prose with no heading or bullets and no more than 50 words. Do not invent details.",
					].join(" "),
			`Conversation: ${prepared.conversationTitle}`,
			previous,
		].join("\n\n"),
		messages: [{ role: "user", content: transcript }],
	};
}

/** The prompt that writes what a bot has been doing lately, from its conversations' summaries. */
export function botSummaryPrompt(prepared: PreparedBotSummary): Models.Prompt {
	const conversations = prepared.conversations
		.map(
			(entry) =>
				`${entry.title} (${entry.doneAt ? "done" : "open"}, last changed ${entry.updatedAt.toISOString()}): ${entry.summary}`,
		)
		.join("\n\n");
	return {
		workspaceId: prepared.workspaceId,
		model: prepared.model,
		system: [
			`Write what the bot ${prepared.botName} has been doing lately, for a person glancing at it to know what it is up to.`,
			"Say what work is going on, what finished recently, and what is waiting on someone, newest first. Use only what the summaries below say; do not invent details.",
			"Return plain prose only: no heading, no bullets, at most 80 words.",
			prepared.previousContent
				? `What you wrote last time, which the summaries below replace where they differ:\n${prepared.previousContent}`
				: "",
		]
			.filter(Boolean)
			.join("\n\n"),
		messages: [{ role: "user", content: conversations }],
	};
}
