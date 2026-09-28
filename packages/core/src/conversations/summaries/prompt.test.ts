import { describe, expect, it } from "vitest";
import { type SummaryPromptInput, threadSummaryPrompt } from "./prompt.ts";

const input: SummaryPromptInput = {
	workspaceId: "0199a3a0-0000-7000-8000-000000000001",
	model: "model",
	threadTitle: "Morning routine",
	transcript: [
		{ author: "Ryan", kind: "person", content: "Set up a daily 9am routine." },
		{ author: "Assistant", kind: "agent", content: "Choose an automation platform." },
	],
};

describe("threadSummaryPrompt", () => {
	it("asks for compact durable context on the first summary", () => {
		const prompt = threadSummaryPrompt(input);

		expect(prompt.system).toContain("only durable context needed to continue the work");
		expect(prompt.system).toContain("Omit conversational back-and-forth");
		expect(prompt.system).toContain("no more than 50 words");
		expect(prompt.system).not.toContain("120 words");
	});

	it("keeps the same size limit when updating a summary", () => {
		const prompt = threadSummaryPrompt({
			...input,
			previousContent: "Ryan needs a morning routine.",
		});

		expect(prompt.system).toContain("no more than 50 words");
		expect(prompt.system).toContain("correct any conflict");
	});
});
