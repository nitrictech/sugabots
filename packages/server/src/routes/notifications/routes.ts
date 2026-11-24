import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { operationCaller } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, memberOnly, refusals } from "../../http/errors.ts";

/** The notification settings and presence of the member signed in, each endpoint its operation. */
export const notificationRoutes = HttpApiBuilder.group(ServerApi, "notifications", (handlers) =>
	Effect.map(operationCaller, (callOperation) =>
		handlers
			.handle("settings", () => callOperation("notifications.settings", {}).pipe(memberOnly))
			.handle("updatePreferences", ({ payload }) =>
				callOperation("notifications.updatePreferences", payload).pipe(memberOnly),
			)
			.handle("setLevel", ({ params, payload }) =>
				callOperation("notifications.setLevel", { ...params, level: payload.level }).pipe(
					asHttpError(refusals),
				),
			)
			.handle("mute", ({ params, payload }) =>
				callOperation("notifications.mute", { ...params, until: payload.until }).pipe(
					asHttpError(refusals),
				),
			)
			.handle("sendTest", () => callOperation("notifications.sendTest", {}).pipe(memberOnly))
			.handle("reportPresence", ({ payload }) =>
				callOperation("notifications.reportPresence", payload).pipe(memberOnly),
			),
	),
);
