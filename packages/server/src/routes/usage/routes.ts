import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { operationCaller } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const usageRoutes = HttpApiBuilder.group(ServerApi, "usage", (handlers) =>
	Effect.map(operationCaller, (callOperation) =>
		handlers.handle("month", ({ params, query }) =>
			callOperation("usage.month", { workspace: params.workspace, ...query }).pipe(
				asHttpError(refusals),
			),
		),
	),
);
