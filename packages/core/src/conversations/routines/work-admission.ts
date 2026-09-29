export * as RoutineWorkAdmission from "./work-admission.ts";

import { Effect, Layer } from "effect";
import { query, serviceOperations } from "../../database/database.ts";
import { WorkAdmission } from "../turns/turns.ts";
import { findRoutineExecutionId, routineAcceptsWork } from "./execution.ts";

/** Admits work into a thread unless the routine run it belongs to takes no more. */
export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<WorkAdmission.Interface>("RoutineWorkAdmission");
	return WorkAdmission.Service.of({
		admits: (threadId) => operation("admits", routineAcceptsWork(threadId)),
		forRoutine: (threadId) =>
			operation(
				"forRoutine",
				Effect.map(
					query((db) => findRoutineExecutionId(db, threadId)),
					(executionId) => executionId !== undefined,
				),
			),
	});
});

export const layer = Layer.effect(WorkAdmission.Service, make);
