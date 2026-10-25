import { Forbidden, NotFound } from "@sugabots/contracts/http";
import { McpApps } from "@sugabots/core/conversations/tools/mcp-apps";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const mcpAppRoutes = HttpApiBuilder.group(ServerApi, "mcpApps", (handlers) =>
	Effect.gen(function* () {
		const apps = yield* McpApps.Service;
		return handlers
			.handle("resource", ({ params }) =>
				apps.resource(params.toolCallId).pipe(asSessionUser, asHttpError(appErrors)),
			)
			.handle("callTool", ({ params, payload }) =>
				apps.callTool(params.toolCallId, payload).pipe(asSessionUser, asHttpError(appErrors)),
			);
	}),
);

const appErrors = {
	...refusals,
	McpAppUnavailable: NotFound,
	McpAppToolRefused: Forbidden,
};
