/**
 * JSON codecs for what crosses Temporal's boundary: payloads, results and
 * exits. Adapted from effect-temporal (MIT); see NOTICE.
 */
import { ApplicationFailure } from "@temporalio/common";
import { Cause, Exit, Schema } from "effect";
import { Workflow } from "effect/unstable/workflow";

/** The failure type a workflow throws to carry its Effect exit out of Temporal. */
export const exitFailureType = "EffectWorkflowExit";

const exitJson = Schema.toCodecJson(Schema.Exit(Schema.Any, Schema.Any, Schema.Defect()));
const encodeAnyExit = Schema.encodeUnknownSync(exitJson);

/** Deferred values cross as generic exits; the deferred's own schema decodes the value. */
export const encodeExit = (exit: Exit.Exit<unknown, unknown>): unknown =>
	encodeAnyExit(Exit.map(exit, (value) => value ?? null));

export const decodeExit = Schema.decodeUnknownSync(exitJson) as (
	encoded: unknown,
) => Exit.Exit<unknown, unknown>;

const resultJson = Schema.toCodecJson(
	Workflow.Result({
		success: Schema.Union([Schema.Any, Schema.Void]),
		error: Schema.Union([Schema.Any, Schema.Void]),
	}),
);

/** An activity's `Workflow.Result`, as its worker returns it to the workflow. */
export const encodeResult = Schema.encodeUnknownSync(resultJson) as (
	result: Workflow.Result<unknown, unknown>,
) => unknown;
export const decodeResult = Schema.decodeUnknownSync(resultJson) as (
	encoded: unknown,
) => Workflow.Result<unknown, unknown>;

export interface Codecs {
	readonly encodePayload: (payload: unknown) => unknown;
	readonly decodePayload: (payload: unknown) => object;
	readonly encodeSuccess: (value: unknown) => unknown;
	readonly decodeSuccess: (value: unknown) => unknown;
	readonly encodeResult: (result: Workflow.Result<unknown, unknown>) => unknown;
	readonly decodeResult: (encoded: unknown) => Workflow.Result<unknown, unknown>;
}

const cache = new WeakMap<Workflow.Any, Codecs>();

/**
 * One workflow's codecs, from its own schemas. The schemas at a workflow's
 * boundary must decode without services, since these run synchronously.
 */
export const codecsFor = (workflow: Workflow.Any): Codecs => {
	const cached = cache.get(workflow);
	if (cached) return cached;
	const payload = jsonCodec(workflow.payloadSchema);
	const success = jsonCodec(workflow.successSchema);
	const result = jsonCodec(
		Workflow.Result({ success: workflow.successSchema, error: workflow.errorSchema }),
	);
	const codecs: Codecs = {
		encodePayload: payload.encode,
		decodePayload: (value) => payload.decode(value) as object,
		encodeSuccess: success.encode,
		decodeSuccess: success.decode,
		encodeResult: result.encode,
		decodeResult: (value) => result.decode(value) as Workflow.Result<unknown, unknown>,
	};
	cache.set(workflow, codecs);
	return codecs;
};

/**
 * A schema's JSON codec, run synchronously. A workflow's schemas are typed
 * as possibly needing services; at Temporal's boundary they must not, and a
 * schema that does fails loudly here.
 */
const jsonCodec = (schema: Schema.Top) => {
	const json = Schema.toCodecJson(schema) as unknown as Schema.Codec<unknown, unknown>;
	return { encode: Schema.encodeUnknownSync(json), decode: Schema.decodeUnknownSync(json) };
};

/** A completed-with-failure result, thrown from the workflow so Temporal records it as the run's failure. */
export const failureFor = (
	workflow: Workflow.Any,
	result: Workflow.Complete<unknown, unknown>,
	cause: Cause.Cause<unknown>,
): ApplicationFailure =>
	ApplicationFailure.create({
		message: Cause.pretty(cause),
		type: exitFailureType,
		nonRetryable: true,
		details: [codecsFor(workflow).encodeResult(result)],
	});

/** The result a failed run carried, if the failure is one `failureFor` made. */
export const resultOfFailure = (
	workflow: Workflow.Any,
	error: unknown,
): Workflow.Result<unknown, unknown> | undefined => {
	for (let current: unknown = error; current instanceof Error; current = current.cause) {
		if (
			current instanceof ApplicationFailure &&
			current.type === exitFailureType &&
			Array.isArray(current.details) &&
			current.details.length > 0
		) {
			return codecsFor(workflow).decodeResult(current.details[0]);
		}
	}
	return undefined;
};
