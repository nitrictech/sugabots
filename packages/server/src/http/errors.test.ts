import { ActionForbidden, BotCannotReach, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { Conflict, Forbidden, NotFound } from "@sugabots/contracts/http";
import type { UserFacing } from "@sugabots/core/user-message";
import { DisplayName, type DomainError, userText } from "@sugabots/errors";
import { Data, Duration, Effect, ErrorReporter, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { asHttpError, refusals } from "./errors.ts";

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

class LegacyRefusal extends Data.TaggedError("LegacyRefusal")<object> implements UserFacing {
	override get message() {
		return "an internal reason";
	}
	get userMessage() {
		return userText`That was refused.`;
	}
}

const failWith = (failure: ProviderRateLimited | LegacyRefusal | NotFound) =>
	Effect.fail(failure).pipe(
		asHttpError({ ProviderRateLimited: Conflict, LegacyRefusal: Conflict }),
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

	it("sends only the user message of an error not yet moved to DomainError", () => {
		expect(failWith(new LegacyRefusal())).toEqual({
			_tag: "Conflict",
			message: "That was refused.",
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

it("answers shared refusals with their HTTP status and public error", () => {
	for (const [refusal, status, tag] of [
		[new ResourceHidden({ resource: "chat" }), 404, "NotFound"],
		[new ActionForbidden({ proof: "CanManageProject" }), 403, "Forbidden"],
		[new BotCannotReach({ resource: "project" }), 403, "Forbidden"],
	] as const) {
		const error = Effect.runSync(Effect.fail(refusal).pipe(asHttpError(refusals), Effect.flip));
		expect(
			Schema.resolveAnnotations(error.constructor as typeof NotFound | typeof Forbidden)
				?.httpApiStatus,
		).toBe(status);
		expect(Schema.encodeSync(Schema.Union([NotFound, Forbidden]))(error)).toEqual({
			_tag: tag,
			message: refusal.userMessage,
			error: { _tag: refusal._tag, userMessage: refusal.userMessage, isRetryable: false },
		});
	}
});
