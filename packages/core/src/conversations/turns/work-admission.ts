export * as WorkAdmission from "./work-admission.ts";

import { Context, type Effect } from "effect";

/**
 * Whether a conversation takes more turns and tool calls. Turns asks before it
 * admits work; automation runs answer it, since a run that has started ending
 * takes no more. Supplied where the conversation services are composed.
 */
export interface Interface {
	/**
	 * Whether the conversation `conversationId` takes more work. The answer stands until
	 * the caller's transaction ends, so ask before locking the turn or tool
	 * call the work is admitted into.
	 */
	readonly admits: (conversationId: string) => Effect.Effect<boolean>;
	/** Whether the conversation `conversationId` does work for an automation run. */
	readonly forAutomation: (conversationId: string) => Effect.Effect<boolean>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/WorkAdmission",
) {}
