import { Cause, Exit, Schema } from "effect";
import { Workflow } from "effect/unstable/workflow";
import { describe, expect, it } from "vitest";
import { codecsFor, decodeExit, encodeExit, failureFor, resultOfFailure } from "./wire.ts";

const Greet = Workflow.make("test/greet", {
	payload: { name: Schema.String },
	success: Schema.String,
	error: Schema.String,
	idempotencyKey: (payload) => payload.name,
});

describe("what crosses Temporal's boundary", () => {
	it("round-trips a deferred's exit", () => {
		expect(decodeExit(encodeExit(Exit.succeed("go")))).toEqual(Exit.succeed("go"));
		expect(Exit.isFailure(decodeExit(encodeExit(Exit.fail("no"))))).toBe(true);
	});

	it("round-trips a workflow's payload and result through its own schemas", () => {
		const codecs = codecsFor(Greet);
		const result = new Workflow.Complete({ exit: Exit.succeed("Hello") });

		expect(codecs.decodePayload(codecs.encodePayload({ name: "Ada" }))).toEqual({ name: "Ada" });
		expect(codecs.decodeResult(codecs.encodeResult(result))).toEqual(result);
	});

	it("carries a failed run's result out as a Temporal failure", () => {
		const result = new Workflow.Complete({ exit: Exit.fail("declined") });
		const failure = failureFor(Greet, result, Cause.fail("declined"));

		expect(resultOfFailure(Greet, new Error("wrapped", { cause: failure }))).toEqual(result);
		expect(resultOfFailure(Greet, new Error("unrelated"))).toBeUndefined();
	});
});
