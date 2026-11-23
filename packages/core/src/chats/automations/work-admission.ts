export * as AutomationWorkAdmission from "./work-admission.ts";

import { Effect, Layer } from "effect";
import { query, serviceOperations } from "../../database/database.ts";
import { WorkAdmission } from "../turns/turns.ts";
import { automationAcceptsWork, findRunBot } from "./execution.ts";

/** Admits work into a chat unless the automation run it belongs to takes no more. */
export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<WorkAdmission.Interface>("AutomationWorkAdmission");
	return WorkAdmission.Service.of({
		admits: (chatId) => operation("admits", automationAcceptsWork(chatId)),
		runBotOf: (chatId) =>
			operation(
				"runBotOf",
				query((db) => findRunBot(db, chatId)),
			),
	});
});

export const layer = Layer.effect(WorkAdmission.Service, make);
