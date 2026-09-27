/**
 * The conformance workflows as Temporal workflow functions: the module a test
 * worker bundles into Temporal's sandbox. Activities never run here, so the
 * probe they record through is a stub that fails if reached.
 */
import {
	Flaky,
	flaky,
	Probe,
	Suspending,
	suspending,
} from "@sugabots/workflow/conformance.workflow";
import { Effect } from "effect";
import { makeWorkflow } from "../runtime.ts";

const inSandbox = Effect.provideService(Probe, {
	record: () => Effect.die(new Error("Activities do not run inside the workflow sandbox")),
	attempt: () => Effect.die(new Error("Activities do not run inside the workflow sandbox")),
});

export const conformance_suspending = makeWorkflow({
	workflow: Suspending,
	execute: suspending,
	provide: inSandbox,
});

export const conformance_flaky = makeWorkflow({
	workflow: Flaky,
	execute: flaky,
	provide: inSandbox,
});
