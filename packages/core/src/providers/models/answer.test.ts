import { Effect, Exit } from "effect";
import { describe, expect, it, vi } from "vitest";
import { Models } from "./models.ts";

describe("asking a model again", () => {
	it("asks up to three times when the answer is the wrong shape", async () => {
		const ask = vi.fn(() => new Models.UnusableAnswer({ reason: "not JSON" }));

		const exit = await Effect.runPromiseExit(Models.retryUnusable(Effect.suspend(ask)));

		expect(ask).toHaveBeenCalledTimes(3);
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("stops as soon as one answer is usable", async () => {
		const ask = vi
			.fn((): Effect.Effect<string, Models.UnusableAnswer> => Effect.succeed("a summary"))
			.mockImplementationOnce(() => new Models.UnusableAnswer({ reason: "not JSON" }));

		const answer = await Effect.runPromise(Models.retryUnusable(Effect.suspend(ask)));

		expect(ask).toHaveBeenCalledTimes(2);
		expect(answer).toBe("a summary");
	});

	it("does not ask again for anything but the shape", async () => {
		// A timeout costs the same next time, and a dead provider is for the
		// caller to handle.
		const ask = vi.fn(() => Effect.fail(new Models.AnswerTimedOut({ purpose: "thread summary" })));

		const exit = await Effect.runPromiseExit(Models.retryUnusable(Effect.suspend(ask)));

		expect(ask).toHaveBeenCalledTimes(1);
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("carries the last reason out, so the fallback can say what went wrong", async () => {
		const exit = await Effect.runPromiseExit(
			Models.retryUnusable(new Models.UnusableAnswer({ reason: "answered with prose" })),
		);

		expect(exit).toStrictEqual(
			Exit.fail(new Models.UnusableAnswer({ reason: "answered with prose" })),
		);
	});
});
