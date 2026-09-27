/**
 * What an Effect runtime needs inside Temporal's workflow sandbox, where every
 * source of time, randomness and scheduling must replay identically. Adapted
 * from effect-temporal (MIT); see NOTICE.
 */
import { inWorkflowContext } from "@temporalio/workflow";
import { Scheduler } from "effect";

/**
 * Runs Effect's scheduled work on microtasks. Effect's default scheduler
 * yields through `setImmediate` or `setTimeout`, which in the sandbox would
 * become durable timers: a flood of commands in the workflow's history.
 */
export const scheduler: Scheduler.Scheduler = new Scheduler.MixedScheduler("async", (run) => {
	let cancelled = false;
	void Promise.resolve().then(() => {
		if (!cancelled) run();
	});
	return () => {
		cancelled = true;
	};
});

/**
 * Supplies the few globals Effect reads that the sandbox lacks, from sources
 * the sandbox already makes deterministic (`Date.now`, `Math.random`).
 */
export const installGlobals = (): void => {
	if (!inWorkflowContext()) return;
	const globals = globalThis as { performance?: unknown; crypto?: { getRandomValues?: unknown } };
	globals.performance = { now: () => Date.now(), timeOrigin: 0 };
	globals.crypto ??= {};
	globals.crypto.getRandomValues ??= <T extends ArrayBufferView>(array: T): T => {
		const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
		for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
		return array;
	};
};
