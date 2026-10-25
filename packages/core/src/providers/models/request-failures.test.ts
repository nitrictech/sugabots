import { DisplayName } from "@sugabots/errors";
import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { anthropic, openrouter, type ProviderDialect } from "../model-providers/dialects/index.ts";
import { classifyRequestFailure } from "./request-failures.ts";

/**
 * What the SDK reports when a provider sends `error` partway through a reply.
 * Run through the real SDK, because it wraps what the provider sent.
 */
async function sentMidStream(error: unknown): Promise<unknown> {
	let reported: unknown;
	const result = streamText({
		model: new MockLanguageModelV4({
			doStream: async () => ({
				stream: simulateReadableStream({ chunks: [{ type: "error", error }] }),
			}),
		}),
		prompt: "Plan this week's meals",
		onError: ({ error }) => {
			reported = error;
		},
	});
	await result.consumeStream();
	return reported;
}

const classify = (cause: unknown, dialect: ProviderDialect) =>
	classifyRequestFailure(cause, {
		provider: DisplayName.fromRecord("OpenRouter"),
		model: DisplayName.fromRecord("Gemini 3.8 Flash"),
		stage: "after-tools",
		recognize: dialect.recognizeFailure,
	});

describe("an error a provider sends partway through a reply", () => {
	it("says a timeout is the provider's trouble, and logs its status", async () => {
		const timedOut = await sentMidStream({
			code: 504,
			message: "The operation was aborted",
			metadata: { error_type: "timeout" },
		});

		expect(classify(timedOut, openrouter)).toMatchObject({
			_tag: "ProviderServerError",
			message: "Provider returned 504: The operation was aborted",
			userMessage:
				"We're having trouble getting an answer from OpenRouter. Try again in a few minutes. If it keeps happening, choose another model.",
		});
	});

	it("is read by the provider's dialect", async () => {
		const busy = await sentMidStream({ type: "overloaded_error", message: "Overloaded" });

		expect(classify(busy, anthropic)._tag).toBe("ProviderOverloaded");
	});
});
