import { CurrentUser } from "@sugabots/contracts/http";
import { workspacePermissions } from "@sugabots/core/workspaces/permissions";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ServerApi } from "../../http/api.ts";
import { grantedWorkspace } from "../../http/authorisation.ts";
import { health } from "../../version.ts";

export const systemRoutes = HttpApiBuilder.group(ServerApi, "system", (handlers) =>
	handlers
		.handle("health", () => Effect.sync(health))
		.handle("me", () => Effect.service(CurrentUser))
		.handle("workspaceAccess", () =>
			Effect.map(grantedWorkspace, ({ actor }) => ({
				role: actor.workspaceRole,
				permissions: workspacePermissions(actor),
			})),
		),
);
