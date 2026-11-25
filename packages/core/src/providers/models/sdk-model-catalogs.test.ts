import { expect, it } from "vitest";
import {
	claudeSupportsAdaptiveThinking,
	geminiThinkingFormat,
	openAIThinkingSupport,
} from "./sdk-model-catalogs.ts";

it("reads adaptive Claude support, Gemini request formats, and OpenAI thinking support from the pinned SDKs", () => {
	expect(claudeSupportsAdaptiveThinking("claude-sonnet-4-6")).toBe(true);
	expect(claudeSupportsAdaptiveThinking("claude-haiku-4-5")).toBe(false);
	expect(geminiThinkingFormat("models/gemini-2.5-flash")).toBe("budget");
	expect(geminiThinkingFormat("gemini-3-flash-preview")).toBe("level");
	expect(openAIThinkingSupport("gpt-5")).toBe(true);
	expect(openAIThinkingSupport("gpt-4.1")).toBe(false);
});
