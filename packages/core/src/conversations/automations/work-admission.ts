export * as AutomationWorkAdmission from "./work-admission.ts";

import { Effect, Layer } from "effect";
import { query, serviceOperations } from "../../database/database.ts";
import { WorkAdmission } from "../turns/turns.ts";
import { automationAcceptsWork, findRunId } from "./execution.ts";

/** Admits work into a conversation unless the automation run it belongs to takes no more. */
export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<WorkAdmission.Interface>("AutomationWorkAdmission");
	return WorkAdmission.Service.of({
		admits: (conversationId) => operation("admits", automationAcceptsWork(conversationId)),
		forAutomation: (conversationId) =>
			operation(
				"forAutomation",
				Effect.map(
					query((db) => findRunId(db, conversationId)),
					(runId) => runId !== undefined,
				),
			),
	});
});

export const layer = Layer.effect(WorkAdmission.Service, make);
