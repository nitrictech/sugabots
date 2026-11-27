import type { ResolvedTargets } from "../../operations/operation.ts";

/**
 * The id a turn recorded a tool call as, which the call's tool is given in
 * the call's context. It stays the same each time the call is sent, so a
 * tool can give it to a destination that takes an idempotency key.
 */

/** The key the recorded call's id is kept under in the call's context. */
const RECORDED_CALL = "recordedCallId";
const RESOLVED_TARGETS = "resolvedTargets";

/** A call's context, as an object to add to. */
function callContext(context: unknown): Record<string, unknown> {
	return typeof context === "object" && context !== null ? { ...context } : {};
}

/** withRecordedCall adds the recorded call id and any targets its approval covers. */
export function withRecordedCall(
	context: unknown,
	callId: string,
	targets?: ResolvedTargets,
): Record<string, unknown> {
	return { ...callContext(context), [RECORDED_CALL]: callId, [RESOLVED_TARGETS]: targets };
}

/** The id the call was recorded as, from its context; undefined for a call no one recorded. */
export function recordedCallOf(context: unknown): string | undefined {
	const recorded = callContext(context)[RECORDED_CALL];
	return typeof recorded === "string" ? recorded : undefined;
}

export function resolvedTargetFromContext(context: unknown, name: string): string | undefined {
	const targets = callContext(context)[RESOLVED_TARGETS];
	const target = callContext(targets)[name];
	return typeof target === "string" ? target : undefined;
}
