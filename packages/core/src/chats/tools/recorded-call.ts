/**
 * The id a turn recorded a tool call as, which the call's tool is given in
 * the call's context. It stays the same each time the call is sent, so a
 * tool can give it to a destination that takes an idempotency key.
 */

/** The key the recorded call's id is kept under in the call's context. */
const RECORDED_CALL = "recordedCallId";

/** A call's context, as an object to add to. */
function callContext(context: unknown): Record<string, unknown> {
	return typeof context === "object" && context !== null ? { ...context } : {};
}

/** The call's context `context`, carrying `callId`, the id its call was recorded as. */
export function withRecordedCall(context: unknown, callId: string): Record<string, unknown> {
	return { ...callContext(context), [RECORDED_CALL]: callId };
}

/** The id the call was recorded as, from its context; undefined for a call no one recorded. */
export function recordedCallOf(context: unknown): string | undefined {
	const recorded = callContext(context)[RECORDED_CALL];
	return typeof recorded === "string" ? recorded : undefined;
}
