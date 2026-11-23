export * as WorkAdmission from "./work-admission.ts";

import { Context, type Effect } from "effect";
import type { BotFacts } from "../../authorization/permissions.ts";

/**
 * Whether a chat takes more turns and tool calls. Turns asks before it
 * admits work; automation runs answer it, since a run that has started ending
 * takes no more. Supplied where the chat services are composed.
 */
export interface Interface {
	/**
	 * Whether the chat `chatId` takes more work. The answer stands until
	 * the caller's transaction ends, so ask before locking the turn or tool
	 * call the work is admitted into.
	 */
	readonly admits: (chatId: string) => Effect.Effect<boolean>;
	/**
	 * The bot doing the automation run the chat `chatId` does work for,
	 * whose managers decide the run's approvals (see `mayDecideToolCall`);
	 * undefined when it does work for none.
	 */
	readonly runBotOf: (chatId: string) => Effect.Effect<BotFacts | undefined>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/WorkAdmission",
) {}
