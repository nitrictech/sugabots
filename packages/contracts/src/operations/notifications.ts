/**
 * The notifications operations' contracts, each with its decisions in the exposure manifest.
 * `index.ts` spreads them, so adding an operation here touches no other file.
 */

import { Schema } from "effect";
import { ActionForbidden, BotCannotReach, ResourceHidden } from "../errors/proofs.ts";
import {
	notificationLevelChoiceSchema,
	notificationMuteSchema,
	notificationPlaceKindSchema,
	notificationPreferencesSchema,
	notificationSettingsSchema,
	presenceSchema,
} from "../notifications.ts";
import { uuidSchema } from "../uuid.ts";
import { OperationContract } from "./operation.ts";

/** How an operation only a member signed in may call refuses anyone else. */
const memberRefusals = [ActionForbidden] as const;

/** How an operation on a project or bot the member must reach refuses. */
const placeRefusals = [ResourceHidden, BotCannotReach, ActionForbidden] as const;

/** A project or a bot, where a member chooses in place of the level above. */
const place = { kind: notificationPlaceKindSchema, id: uuidSchema };

/** Held back: notifications are their member's own, set from their own tabs. */
const membersOwn = {
	kind: "heldBack",
	reason:
		"A member's notifications and tabs are their own, set from the web app; only a member signed in may change them.",
} as const;

export const notificationsContracts = {
	"notifications.settings": OperationContract.make("notifications.settings", {
		description: "Read what you are notified about, and when not.",
		input: Schema.Struct({}),
		output: notificationSettingsSchema,
		errors: memberRefusals,
		changes: false,
		http: { kind: "offered", method: "GET", path: "/notifications" },
		botLoop: membersOwn,
	}),
	"notifications.updatePreferences": OperationContract.make("notifications.updatePreferences", {
		description:
			"Change what you are notified about everywhere, when you are paused, and your quiet hours.",
		input: notificationPreferencesSchema,
		output: notificationSettingsSchema,
		errors: memberRefusals,
		changes: true,
		http: { kind: "offered", method: "PUT", path: "/notifications" },
		botLoop: membersOwn,
	}),
	"notifications.setLevel": OperationContract.make("notifications.setLevel", {
		description:
			"Choose what you are notified about in a project or bot you reach, or with none go back to the level above, ending its mute.",
		input: Schema.Struct({ ...place, ...notificationLevelChoiceSchema.fields }),
		output: Schema.Void,
		errors: placeRefusals,
		changes: true,
		http: { kind: "offered", method: "PUT", path: "/notifications/:kind/:id/level" },
		botLoop: membersOwn,
	}),
	"notifications.mute": OperationContract.make("notifications.mute", {
		description:
			"Mute a project or bot you reach until a time, or with none, or a time passed, end its mute.",
		input: Schema.Struct({ ...place, ...notificationMuteSchema.fields }),
		output: Schema.Void,
		errors: placeRefusals,
		changes: true,
		http: { kind: "offered", method: "PUT", path: "/notifications/:kind/:id/mute" },
		botLoop: membersOwn,
	}),
	"notifications.sendTest": OperationContract.make("notifications.sendTest", {
		description: "Notify every tab you have open, whatever you chose, to see that it works.",
		input: Schema.Struct({}),
		output: Schema.Void,
		errors: memberRefusals,
		changes: false,
		http: { kind: "offered", method: "POST", path: "/notifications/test" },
		botLoop: membersOwn,
	}),
	"notifications.reportPresence": OperationContract.make("notifications.reportPresence", {
		description: "Tell your other tabs which chat one of yours is showing.",
		input: presenceSchema,
		output: Schema.Void,
		errors: memberRefusals,
		changes: false,
		http: { kind: "offered", method: "PUT", path: "/notifications/presence" },
		botLoop: membersOwn,
	}),
} as const;
