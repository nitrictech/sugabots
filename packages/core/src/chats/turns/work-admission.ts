export * as WorkAdmission from "./work-admission.ts";

import { Context, type Effect } from "effect";
import type { Transaction } from "../../database/database.ts";
import { Tier } from "../../tiers.ts";

/**
 * Whether a chat takes more turns and tool calls. Turns asks before it
 * admits work. The answer includes its project and any automation run it is
 * in. Supplied where the chat services are composed.
 */
export type Refusal = "chatUnavailable" | "automationEnded";

export interface Interface {
	/**
	 * Why the chat `chatId` refuses work, if it does. The answer stands until
	 * the caller's transaction ends, so ask before locking the turn or tool
	 * call the work is admitted into.
	 */
	readonly refusal: (chatId: string) => Effect.Effect<Refusal | undefined, never, Transaction>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/WorkAdmission") {
	declare readonly [Tier]: "process";
}
