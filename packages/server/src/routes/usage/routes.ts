import { Usage } from "@sugabots/core/accounting/usage";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const usageRoutes = HttpApiBuilder.group(ServerApi, "usage", (handlers) =>
	Effect.gen(function* () {
		const usage = yield* Usage.Service;
		return handlers.handle("month", ({ params, query }) =>
			usage
				.month({ workspace: params.workspace, ...query })
				.pipe(asSessionUser, asHttpError(refusals)),
		);
	}),
);
