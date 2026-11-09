import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	notificationLevelChoiceSchema,
	notificationMuteSchema,
	notificationPlaceKindSchema,
	notificationPreferencesSchema,
	notificationSettingsSchema,
	presenceSchema,
	pushDeviceSchema,
	pushRegistrationSchema,
} from "../../notifications.ts";
import { uuidSchema } from "../../uuid.ts";
import { BadRequest, Forbidden, refused } from "../errors.ts";
import { Session } from "../middleware.ts";

/**
 * The signed-in person's notifications: what they are notified about, which
 * conversation they are looking at, and the phone the session is signed in on.
 */
const place = { kind: notificationPlaceKindSchema, id: uuidSchema };

export class NotificationsApi extends HttpApiGroup.make("notifications")
	.add(
		HttpApiEndpoint.get("settings", "/notifications", { success: notificationSettingsSchema }),
		HttpApiEndpoint.put("updatePreferences", "/notifications", {
			payload: notificationPreferencesSchema,
			success: notificationSettingsSchema,
		}),
		HttpApiEndpoint.put("setLevel", "/notifications/:kind/:id/level", {
			params: place,
			payload: notificationLevelChoiceSchema,
			success: HttpApiSchema.Empty(204),
			error: refused,
		}),
		HttpApiEndpoint.put("mute", "/notifications/:kind/:id/mute", {
			params: place,
			payload: notificationMuteSchema,
			success: HttpApiSchema.Empty(204),
			error: refused,
		}),
		HttpApiEndpoint.post("sendTest", "/notifications/test", {
			success: HttpApiSchema.Empty(204),
		}),
		HttpApiEndpoint.put("reportPresence", "/notifications/presence", {
			payload: presenceSchema,
			success: HttpApiSchema.Empty(204),
		}),
		/**
		 * Only from the app, signed in with a bearer token: a browser's session
		 * has no phone, and registering lengthens the session.
		 */
		HttpApiEndpoint.put("registerDevice", "/notifications/device", {
			payload: pushDeviceSchema,
			success: pushRegistrationSchema,
			error: [Forbidden, BadRequest],
		}),
		HttpApiEndpoint.delete("unregisterDevice", "/notifications/device", {
			success: HttpApiSchema.Empty(204),
		}),
	)
	.middleware(Session) {}
