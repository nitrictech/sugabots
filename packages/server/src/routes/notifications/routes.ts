import { Notifications } from "@sugabots/core/notifications/notifications";
import { DateTime, Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asCurrentUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

/** The current user's notification settings and presence. */
export const notificationRoutes = HttpApiBuilder.group(ServerApi, "notifications", (handlers) =>
	Effect.gen(function* () {
		const notifications = yield* Notifications.Service;
		return handlers
			.handle("settings", () => notifications.settings.pipe(asCurrentUser))
			.handle("updatePreferences", ({ payload }) =>
				notifications.updatePreferences(payload).pipe(asCurrentUser),
			)
			.handle("setLevel", ({ params, payload }) =>
				notifications.setLevel(params, payload.level).pipe(asCurrentUser, asHttpError(refusals)),
			)
			.handle("mute", ({ params, payload }) =>
				notifications
					.mute(
						params,
						payload.until === null ? null : DateTime.toDate(DateTime.makeUnsafe(payload.until)),
					)
					.pipe(asCurrentUser, asHttpError(refusals)),
			)
			.handle("sendTest", () => notifications.sendTest.pipe(asCurrentUser))
			.handle("reportPresence", ({ payload }) =>
				notifications.reportPresence(payload).pipe(asCurrentUser),
			);
	}),
);
