import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	notificationLevelChoiceSchema,
	notificationMuteSchema,
	notificationPlaceKindSchema,
	notificationPreferencesSchema,
	notificationSettingsSchema,
	presenceSchema,
} from "../../notifications.ts";
import { uuidSchema } from "../../uuid.ts";
import { refused } from "../errors.ts";
import { Session } from "../middleware.ts";

/**
 * The signed-in person's notifications: what they are notified about, and
 * which conversation they are looking at.
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
	)
	.middleware(Session) {}
