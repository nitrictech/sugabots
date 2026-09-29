import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
	notificationPreferencesSchema,
	updateNotificationDeliverySchema,
	updateNotificationPreferenceSchema,
} from "../../notifications.ts";
import { Session } from "../middleware.ts";

/** What the signed-in person wants to be told about, and how, in every workspace they belong to. */
export class NotificationsApi extends HttpApiGroup.make("notifications")
	.add(
		HttpApiEndpoint.get("preferences", "/notifications/preferences", {
			success: notificationPreferencesSchema,
		}),
		HttpApiEndpoint.patch("updatePreference", "/notifications/preferences", {
			payload: updateNotificationPreferenceSchema,
			success: notificationPreferencesSchema,
		}),
		HttpApiEndpoint.patch("updateDelivery", "/notifications/delivery", {
			payload: updateNotificationDeliverySchema,
			success: notificationPreferencesSchema,
		}),
	)
	.middleware(Session) {}
