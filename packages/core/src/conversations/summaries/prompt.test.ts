import { describe, expect, it } from "vitest";
import { conversationSummaryPrompt, type SummaryPromptInput } from "./prompt.ts";

const input: SummaryPromptInput = {
	workspaceId: "0199a3a0-0000-7000-8000-000000000001",
	model: "model",
	conversationTitle: "Morning automation",
	transcript: [
		{ author: "Rowan", kind: "person", content: "Set up a daily 9am automation." },
		{ author: "Assistant", kind: "bot", content: "Choose an automation platform." },
	],
};

describe("conversationSummaryPrompt", () => {
	it("asks for compact durable context on the first summary", () => {
		const prompt = conversationSummaryPrompt(input);

		expect(prompt.system).toContain("only durable context needed to continue the work");
		expect(prompt.system).toContain("Omit conversational back-and-forth");
		expect(prompt.system).toContain("no more than 50 words");
	});

	it("keeps the same size limit when updating a summary", () => {
		const prompt = conversationSummaryPrompt({
			...input,
			previousContent: "Rowan needs a morning automation.",
		});

		expect(prompt.system).toContain("no more than 50 words");
		expect(prompt.system).toContain("correct any conflict");
	});
});
