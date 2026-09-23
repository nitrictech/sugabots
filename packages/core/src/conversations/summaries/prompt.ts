import type { TurnModelInput } from "../turns/model.ts";
import type { PreparedSummary } from "./store.ts";

/** What the prompt reads. Narrower than a `PreparedSummary` so a model trial can build one. */
export type SummaryPromptInput = Pick<
	PreparedSummary,
	"workspaceId" | "model" | "threadTitle" | "previousContent" | "transcript"
>;

export function threadSummaryPrompt(
	prepared: SummaryPromptInput,
	signal: AbortSignal,
): TurnModelInput {
	const previous = prepared.previousContent
		? `Previous summary:\n${prepared.previousContent}`
		: "There is no previous summary.";
	const transcript = prepared.transcript
		.map((entry) => `${entry.author} (${entry.kind}): ${entry.content}`)
		.join("\n\n");

	return {
		workspaceId: prepared.workspaceId,
		model: prepared.model,
		signal,
		system: [
			"Write a compact thread summary containing only durable context needed to continue the work.",
			"Keep confirmed facts, decisions, results, unresolved questions, owners, and the immediate next step. Omit conversational back-and-forth, acknowledgements, apologies, superseded corrections, and repeated details.",
			prepared.previousContent
				? "The transcript includes recent overlap with the previous summary. Treat the transcript as authoritative and correct any conflict. Return plain prose only, with no heading, no bullets, and no more than 50 words. Do not invent details."
				: [
						"This is the first completed exchange. Return strict JSON with exactly two string fields: title and summary.",
						"The title must describe the actual work, contain no surrounding quotes or invented identifiers, and be at most 80 characters.",
						"The summary must be plain prose with no heading or bullets and no more than 50 words. Do not invent details.",
					].join(" "),
			`Thread: ${prepared.threadTitle}`,
			previous,
		].join("\n\n"),
		messages: [{ role: "user", content: transcript }],
	};
}
