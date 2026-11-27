/**
 * The events operations' contracts, each with its decisions in the exposure manifest:
 * following a stream, which the event stream entrypoint does, and telling a
 * chat's watchers someone is typing. `index.ts` spreads them, so adding an
 * operation here touches no other file.
 */

import { Schema } from "effect";
import { ActionForbidden, BotCannotReach, ResourceHidden } from "../errors/proofs.ts";
import { streamEventSchema } from "../events.ts";
import { uuidOrStringSchema } from "../uuid.ts";
import { workspaceIdOrSlugSchema } from "../workspaces.ts";
import { OperationContract } from "./operation.ts";

/**
 * Where a client resumes a stream, its `Last-Event-ID`: the `seq` of the last
 * durable event it heard, or the one `ready` or `reset` gave it, which is 0
 * for a stream with nothing stored yet. Left out, the stream starts with what
 * happens next.
 */
const since = Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)));

/**
 * One event as a stream yields it: a durable one with its `seq`, the id a
 * client resumes from, and an ephemeral one, such as a reply's text as it is
 * written, without.
 */
const deliverySchema = Schema.Struct({
	seq: Schema.optional(Schema.Int),
	event: streamEventSchema,
});

export type Delivery = typeof deliverySchema.Type;

const following = {
	heldBackFromHttp: {
		kind: "heldBack",
		reason: "The event stream entrypoint follows it, over server-sent events.",
	},
	heldBackFromBots: {
		kind: "heldBack",
		reason: "Clients follow streams; a bot reads its chat through its turn.",
	},
} as const;

export const eventsContracts = {
	"events.followWorkspace": OperationContract.makeLongRunning("events.followWorkspace", {
		description:
			"Follow what changes in this workspace: each event about a chat, project, bot or membership the member reaches, as it happens.",
		input: Schema.Struct({ workspace: workspaceIdOrSlugSchema, since }),
		output: deliverySchema,
		errors: [ResourceHidden, BotCannotReach, ActionForbidden],
		http: following.heldBackFromHttp,
		botLoop: following.heldBackFromBots,
	}),
	"events.followChat": OperationContract.makeLongRunning("events.followChat", {
		description: "Follow what changes in this chat, as it happens.",
		input: Schema.Struct({ chatId: uuidOrStringSchema, since }),
		output: deliverySchema,
		errors: [ResourceHidden, BotCannotReach, ActionForbidden],
		http: following.heldBackFromHttp,
		botLoop: following.heldBackFromBots,
	}),
	"events.followOwn": OperationContract.makeLongRunning("events.followOwn", {
		description:
			"Follow what is for the member alone, such as their notifications and what their other tabs show.",
		input: Schema.Struct({ since }),
		output: deliverySchema,
		errors: [ActionForbidden],
		http: following.heldBackFromHttp,
		botLoop: following.heldBackFromBots,
	}),
	"events.reportTyping": OperationContract.make("events.reportTyping", {
		description: "Tell this chat's other watchers the member is typing in it.",
		input: Schema.Struct({ chatId: uuidOrStringSchema }),
		output: Schema.Void,
		errors: [ResourceHidden, BotCannotReach, ActionForbidden],
		changes: false,
		http: { kind: "offered", method: "POST", path: "/chats/:chatId/typing" },
		botLoop: {
			kind: "heldBack",
			reason: "Only members type; a bot's reply shows as it is written.",
		},
	}),
} as const;
