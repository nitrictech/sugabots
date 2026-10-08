import { type Brand, Duration, ErrorReporter, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import { DisplayName, type DomainError, toPublicError, userText } from "./index.ts";

class ProviderRateLimited
	extends Schema.TaggedError<ProviderRateLimited>()("ProviderRateLimited", {
		bot: DisplayName.schema,
		provider: DisplayName.schema,
		retryAfter: Schema.Duration,
		cause: Schema.Defect(),
	})
	implements DomainError
{
	readonly isRetryable = true;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return `provider answered 429: ${String(this.cause)}`;
	}
	get userMessage() {
		return userText`${this.bot} couldn't reply because ${this.provider} is limiting how often this workspace can ask it.`;
	}
}

/** Everything a DomainError has but a user message. */
class WithoutUserMessage extends Schema.TaggedError<WithoutUserMessage>()(
	"WithoutUserMessage",
	{},
) {
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
}

const rateLimited = (retryAfter: Duration.Duration) =>
	new ProviderRateLimited({
		bot: DisplayName.fromRecord("Dog Training Coach"),
		provider: DisplayName.fromRecord("Acme Models"),
		retryAfter,
		cause: new Error("429 Too Many Requests: key sk-live-123 over its limit"),
	});

describe("userText", () => {
	it("puts display names and fixed words into our words", () => {
		const count = 2 as number;
		const verb = count === 1 ? "uses" : "use";

		expect(rateLimited(Duration.minutes(2)).userMessage).toBe(
			"Dog Training Coach couldn't reply because Acme Models is limiting how often this workspace can ask it.",
		);
		expect(userText`${count} bots ${verb} it.`).toBe("2 bots use it.");
	});

	it("refuses text that could hold anything", () => {
		const fromAnException: string = new Error("ECONNREFUSED 127.0.0.1:11434").message;
		const someId = "0199a3a0" as Brand.Branded<string, "AgentId">;

		// @ts-expect-error: a plain string could hold anything.
		userText`Failed: ${fromAnException}.`;
		// @ts-expect-error: an error's internal message is for the logs.
		userText`Failed: ${rateLimited(Duration.minutes(2)).message}.`;
		// @ts-expect-error: a string branded as something else is not a name the reader is shown.
		userText`Failed: ${someId}.`;
	});
});

describe("toPublicError", () => {
	it("keeps only what may be told outside", () => {
		const failure = rateLimited(Duration.minutes(2));

		expect(toPublicError(failure)).toStrictEqual({
			_tag: "ProviderRateLimited",
			userMessage: failure.userMessage,
			isRetryable: true,
			retryAfter: Duration.minutes(2),
		});
	});

	it("leaves out a wait with no end, which has no time to send", () => {
		expect(toPublicError(rateLimited(Duration.infinity))).not.toHaveProperty("retryAfter");
	});
});

describe("DomainError", () => {
	it("is only a class with every member", () => {
		expectTypeOf<ProviderRateLimited>().toExtend<DomainError>();
		expectTypeOf<WithoutUserMessage>().not.toExtend<DomainError>();
	});
});
