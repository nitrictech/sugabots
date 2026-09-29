import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
	notificationPreferencesSchema,
	updateNotificationPreferenceSchema,
} from "../../notifications.ts";
import { Session } from "../middleware.ts";

/** What the signed-in person wants to be told about, in every workspace they belong to. */
export class NotificationsApi extends HttpApiGroup.make("notifications")
	.add(
		HttpApiEndpoint.get("preferences", "/notifications/preferences", {
			success: notificationPreferencesSchema,
		}),
		HttpApiEndpoint.patch("updatePreference", "/notifications/preferences", {
			payload: updateNotificationPreferenceSchema,
			success: notificationPreferencesSchema,
		}),
	)
	.middleware(Session) {}
