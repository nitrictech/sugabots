import { Notifications } from "@sugabots/core/notifications/notifications";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";

export const notificationRoutes = HttpApiBuilder.group(ServerApi, "notifications", (handlers) =>
	Effect.gen(function* () {
		const notifications = yield* Notifications.Service;
		return handlers
			.handle("preferences", () => notifications.preferences.pipe(asSessionUser))
			.handle("updatePreference", ({ payload }) =>
				notifications.setPreference(payload).pipe(asSessionUser),
			);
	}),
);
