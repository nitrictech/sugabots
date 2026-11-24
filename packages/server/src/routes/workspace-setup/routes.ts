import { BadRequest } from "@sugabots/contracts/http";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { operationCaller } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

/** The member signed in finishing setting up a workspace. */
export const workspaceSetupRoutes = HttpApiBuilder.group(ServerApi, "workspaceSetup", (handlers) =>
	Effect.map(operationCaller, (callOperation) =>
		handlers.handle("complete", ({ payload }) =>
			callOperation("workspaceSetup.complete", payload).pipe(asHttpError(workspaceSetupErrors)),
		),
	),
);

const workspaceSetupErrors = {
	...refusals,
	NotReadyToFinish: BadRequest,
	NoModelChosen: BadRequest,
};
