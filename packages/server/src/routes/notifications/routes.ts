import { BadRequest, CurrentSession, Forbidden } from "@sugabots/contracts/http";
import { Notifications } from "@sugabots/core/notifications/notifications";
import { userText } from "@sugabots/errors";
import { DateTime, Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

/** The signed-in person's notification settings, presence and phones. */
export const notificationRoutes = HttpApiBuilder.group(ServerApi, "notifications", (handlers) =>
	Effect.gen(function* () {
		const notifications = yield* Notifications.Service;
		return handlers
			.handle("settings", () => notifications.settings.pipe(asSessionUser))
			.handle("updatePreferences", ({ payload }) =>
				notifications.updatePreferences(payload).pipe(asSessionUser),
			)
			.handle("setLevel", ({ params, payload }) =>
				notifications.setLevel(params, payload.level).pipe(asSessionUser, asHttpError(refusals)),
			)
			.handle("mute", ({ params, payload }) =>
				notifications
					.mute(
						params,
						payload.until === null ? null : DateTime.toDate(DateTime.makeUnsafe(payload.until)),
					)
					.pipe(asSessionUser, asHttpError(refusals)),
			)
			.handle("sendTest", () => notifications.sendTest.pipe(asSessionUser))
			.handle("reportPresence", ({ payload }) =>
				notifications.reportPresence(payload).pipe(asSessionUser),
			)
			.handle("registerDevice", ({ payload }) =>
				Effect.gen(function* () {
					const current = yield* CurrentSession;
					if (current.credential !== "bearer") {
						return yield* new Forbidden({
							message: userText`Only the app can be notified on a phone`,
						});
					}
					return yield* notifications.registerDevice(current.id, payload);
				}).pipe(asSessionUser, asHttpError({ PushDeviceRefused: BadRequest })),
			)
			.handle("unregisterDevice", () =>
				Effect.flatMap(CurrentSession, (session) =>
					notifications.unregisterDevice(session.id),
				).pipe(asSessionUser),
			);
	}),
);
