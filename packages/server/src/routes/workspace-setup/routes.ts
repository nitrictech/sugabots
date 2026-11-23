import { BadRequest } from "@sugabots/contracts/http";
import { WorkspaceSetup } from "@sugabots/core/workspaces/workspace-setup/workspace-setup";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSignedInPerson } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

/** The signed-in person finishing setting up a workspace. */
export const workspaceSetupRoutes = HttpApiBuilder.group(ServerApi, "workspaceSetup", (handlers) =>
	Effect.gen(function* () {
		const workspaceSetup = yield* WorkspaceSetup.Service;
		return handlers.handle("complete", ({ payload }) =>
			workspaceSetup.complete(payload).pipe(asSignedInPerson, asHttpError(workspaceSetupErrors)),
		);
	}),
);

const workspaceSetupErrors = {
	...refusals,
	NotReadyToFinish: BadRequest,
	NoModelChosen: BadRequest,
};
