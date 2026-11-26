import { Effect } from "effect";
import { SystemWorkAuthentication } from "../authentication/system-work.ts";
import { scheduledWorkOperations } from "../operations/scheduled-work.ts";

import { ProjectComputers } from "./project-computers.ts";

export const sweepIdleComputers = (computers: ProjectComputers.Interface) =>
	Effect.gen(function* () {
		const auth = yield* SystemWorkAuthentication.Service;
		for (const computerId of yield* auth.idleComputerIds) {
			const principal = yield* auth.computerSleep(computerId);
			yield* scheduledWorkOperations["projectComputer.sleepIfIdle"]
				.run(principal, { computerId }, { kind: "request", request: crypto.randomUUID() })
				.pipe(Effect.provideService(ProjectComputers.Service, computers));
		}
	}).pipe(Effect.provide(SystemWorkAuthentication.layer));
