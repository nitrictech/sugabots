import { Conflict, NotFound } from "@sugabots/contracts/http";
import { DisplayName, type DomainError, userText } from "@sugabots/errors";
import { Duration, Effect, ErrorReporter, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { asHttpError } from "./errors.ts";

class ProviderRateLimited
	extends Schema.TaggedError<ProviderRateLimited>()("ProviderRateLimited", {
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
		return userText`${this.provider} is limiting how often this workspace can ask it.`;
	}
}

const failWith = (failure: ProviderRateLimited | NotFound) =>
	Effect.fail(failure).pipe(
		asHttpError({ ProviderRateLimited: Conflict }),
		Effect.flip,
		Effect.map(Schema.encodeSync(Schema.Union([Conflict, NotFound]))),
		Effect.runSync,
	);

describe("asHttpError", () => {
	it("sends a DomainError's public form and nothing else", () => {
		const failure = new ProviderRateLimited({
			provider: DisplayName.fromRecord("Acme Models"),
			retryAfter: Duration.minutes(2),
			cause: new Error("429 Too Many Requests: key sk-live-123 over its limit"),
		});

		expect(failWith(failure)).toEqual({
			_tag: "Conflict",
			message: "Acme Models is limiting how often this workspace can ask it.",
			error: {
				_tag: "ProviderRateLimited",
				userMessage: "Acme Models is limiting how often this workspace can ask it.",
				isRetryable: true,
				retryAfterMillis: 120_000,
			},
		});
	});

	it("passes a failure already in the API's terms through as it is", () => {
		const refusal = new NotFound({
			message: userText`No such chat`,
			details: { id: "t1" },
		});

		expect(failWith(refusal)).toEqual({
			_tag: "NotFound",
			message: "No such chat",
			details: { id: "t1" },
		});
	});
});
