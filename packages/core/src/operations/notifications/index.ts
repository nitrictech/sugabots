/**
 * The notifications operations' bodies, and the layer of the services they are
 * built from. `registry.ts` gathers the operations and `layer.ts` the layers,
 * so adding an operation here touches no other file.
 */

import { Notifications } from "../../notifications/notifications.ts";
import { mute } from "./mute.ts";
import { reportPresence } from "./report-presence.ts";
import { sendTest } from "./send-test.ts";
import { setLevel } from "./set-level.ts";
import { settings } from "./settings.ts";
import { updatePreferences } from "./update-preferences.ts";

export const notificationsOperations = {
	"notifications.settings": settings,
	"notifications.updatePreferences": updatePreferences,
	"notifications.setLevel": setLevel,
	"notifications.mute": mute,
	"notifications.sendTest": sendTest,
	"notifications.reportPresence": reportPresence,
};

export const notificationsLayer = Notifications.layer;
