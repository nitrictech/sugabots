export * as WorkAdmission from "./work-admission.ts";

import { Context, type Effect } from "effect";

/**
 * Whether a thread takes more turns and tool calls. Turns asks before it
 * admits work; routine runs answer it, since a run that has started ending
 * takes no more. Supplied where the conversation services are composed.
 */
export interface Interface {
	/**
	 * Whether the thread `threadId` takes more work. The answer stands until
	 * the caller's transaction ends, so ask before locking the turn or tool
	 * call the work is admitted into.
	 */
	readonly admits: (threadId: string) => Effect.Effect<boolean>;
	/** Whether the thread `threadId` does work for a routine run. */
	readonly forRoutine: (threadId: string) => Effect.Effect<boolean>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/WorkAdmission",
) {}
