/**
 * Near-misses with the exposure manifest, one per entry under
 * `@ts-expect-error`. Type-checked and never run or imported. The lint check
 * reads each directive's TS code and bracketed message fragment to verify
 * that the line fails for the intended reason.
 *
 * The operations here are stand-ins; the endpoints are real ones of `Api`.
 */

import { Schema } from "effect";
import { defineManifest } from "./exposure.ts";
import { OperationContract } from "./operation.ts";

const setResolved = OperationContract.make("chats.setResolved", {
	description: "Mark this chat resolved, or reopen it.",
	input: Schema.Struct({ chatId: Schema.String, resolved: Schema.Boolean }),
	output: Schema.Void,
	errors: [],
	changes: true,
});
const rename = OperationContract.make("chats.rename", {
	description: "Rename this chat.",
	input: Schema.Struct({ chatId: Schema.String, name: Schema.String }),
	output: Schema.Void,
	errors: [],
	changes: true,
});
const follow = OperationContract.make("events.followChat", {
	description: "Follow what changes in this chat.",
	input: Schema.Struct({ chatId: Schema.String }),
	output: Schema.Void,
	errors: [],
	changes: false,
});

const contracts = {
	"chats.setResolved": setResolved,
	"chats.rename": rename,
	"events.followChat": follow,
};
const define = defineManifest<typeof contracts>();

const heldBackFromBots = {
	kind: "heldBack",
	reason: "Clients follow events; a bot reads them in its turn.",
} as const;
declare const computedReason: string;
const resolveChatTool = {
	kind: "offered",
	tool: "resolve_chat",
	offeredIn: "everywhere",
	approval: { kind: "never" },
} as const;
const renameChatTool = {
	kind: "offered",
	tool: "rename_chat",
	offeredIn: "chatBounds",
	approval: { kind: "always", approvers: "turn" },
} as const;

export const sound = define({
	"chats.setResolved": {
		http: { kind: "offered", endpoint: "chats.markResolved" },
		botLoop: resolveChatTool,
	},
	"chats.rename": {
		http: { kind: "offered", endpoint: "chats.renameChat" },
		botLoop: {
			kind: "coveredBy",
			operation: "chats.setResolved",
			reason: "Stand-in: a covered operation names one offered directly.",
		},
	},
	"events.followChat": {
		http: { kind: "heldBack", reason: "Stand-in: the event stream serves it." },
		botLoop: heldBackFromBots,
	},
});

// A missing entry.
// @ts-expect-error TS2345 [Property '"events.followChat"']
export const missingEntry = define({
	"chats.setResolved": {
		http: { kind: "offered", endpoint: "chats.markResolved" },
		botLoop: resolveChatTool,
	},
	"chats.rename": {
		http: { kind: "offered", endpoint: "chats.renameChat" },
		botLoop: renameChatTool,
	},
});

export const unregistered = define({
	"chats.setResolved": {
		http: { kind: "offered", endpoint: "chats.markResolved" },
		botLoop: resolveChatTool,
	},
	"chats.rename": {
		http: { kind: "offered", endpoint: "chats.renameChat" },
		botLoop: renameChatTool,
	},
	"events.followChat": {
		http: { kind: "heldBack", reason: "Stand-in." },
		botLoop: heldBackFromBots,
	},
	// An entry for an operation nobody registered.
	// @ts-expect-error TS2322 [Property '"no operation is registered under this name"']
	"chats.misspelt": { http: { kind: "heldBack", reason: "Stand-in." }, botLoop: heldBackFromBots },
});

export const noReason = define({
	"chats.setResolved": {
		http: { kind: "offered", endpoint: "chats.markResolved" },
		botLoop: resolveChatTool,
	},
	// `heldBack` with no reason.
	// @ts-expect-error TS2322 [Property 'reason']
	"chats.rename": { http: { kind: "heldBack" }, botLoop: heldBackFromBots },
	"events.followChat": {
		http: { kind: "heldBack", reason: "Stand-in." },
		botLoop: heldBackFromBots,
	},
});

export const blankReason = define({
	"chats.setResolved": {
		http: { kind: "offered", endpoint: "chats.markResolved" },
		botLoop: resolveChatTool,
	},
	"chats.rename": {
		http: { kind: "offered", endpoint: "chats.renameChat" },
		botLoop: heldBackFromBots,
	},
	// `heldBack` with a blank reason.
	// @ts-expect-error TS2322 [Property '"a decision that holds back or covers an operation needs its reason w]
	"events.followChat": { http: { kind: "heldBack", reason: "  " }, botLoop: heldBackFromBots },
});

export const typedReason = define({
	"chats.setResolved": {
		http: { kind: "offered", endpoint: "chats.markResolved" },
		botLoop: resolveChatTool,
	},
	"chats.rename": {
		http: { kind: "offered", endpoint: "chats.renameChat" },
		botLoop: heldBackFromBots,
	},
	// A reason typed as `string`, which nobody wrote here.
	// @ts-expect-error TS2322 [Property '"a decision that holds back or covers an operation needs its reason w]
	"events.followChat": {
		http: { kind: "heldBack", reason: computedReason },
		botLoop: heldBackFromBots,
	},
});

export const covers = define({
	// The covering operation is absent from the manifest.
	// @ts-expect-error TS2322 [Property '"covered by an operation the bot loop must offer directly: not this o]
	"chats.setResolved": {
		http: { kind: "offered", endpoint: "chats.markResolved" },
		botLoop: { kind: "coveredBy", operation: "chats.unknown", reason: "Stand-in." },
	},
	// Covered by an operation the bot loop holds back.
	// @ts-expect-error TS2322 [Property '"covered by an operation the bot loop must offer directly: not this o]
	"chats.rename": {
		http: { kind: "offered", endpoint: "chats.renameChat" },
		botLoop: { kind: "coveredBy", operation: "events.followChat", reason: "Stand-in." },
	},
	"events.followChat": {
		http: { kind: "heldBack", reason: "Stand-in." },
		botLoop: heldBackFromBots,
	},
});

export const misspeltEndpoint = define({
	"chats.setResolved": {
		// A misspelt endpoint.
		// @ts-expect-error TS2322 [Type '"chats.archiveChats"' is not assignable to type 'EndpointName']
		http: { kind: "offered", endpoint: "chats.archiveChats" },
		botLoop: resolveChatTool,
	},
	"chats.rename": {
		http: { kind: "offered", endpoint: "chats.renameChat" },
		botLoop: heldBackFromBots,
	},
	"events.followChat": {
		http: { kind: "heldBack", reason: "Stand-in." },
		botLoop: heldBackFromBots,
	},
});

// A contract filed under another operation's name.
// @ts-expect-error TS2344 [Types of property '"chats.rename"' are incompatible.]
export const misfiled = defineManifest<{ "chats.rename": typeof setResolved }>();

// Two operations naming one endpoint.
// @ts-expect-error TS2345 [Property '"one operation per endpoint: these operations name the same endpoint"']
export const sharedEndpoint = define({
	"chats.setResolved": {
		http: { kind: "offered", endpoint: "chats.markResolved" },
		botLoop: resolveChatTool,
	},
	"chats.rename": {
		http: { kind: "offered", endpoint: "chats.renameChat" },
		botLoop: heldBackFromBots,
	},
	"events.followChat": {
		http: { kind: "offered", endpoint: "chats.renameChat" },
		botLoop: heldBackFromBots,
	},
});

export const unbounded = define({
	"chats.setResolved": {
		http: { kind: "offered", endpoint: "chats.markResolved" },
		// A tool that doesn't say in which bounds it is offered.
		// @ts-expect-error TS2322 [Type '{ kind: "offered"; tool: string; approval: { kind: "never"; }; }' is not assignable to type 'BotLoopDeci]
		botLoop: { kind: "offered", tool: "resolve_chat", approval: { kind: "never" } },
	},
	"chats.rename": {
		http: { kind: "offered", endpoint: "chats.renameChat" },
		botLoop: heldBackFromBots,
	},
	"events.followChat": {
		http: { kind: "heldBack", reason: "Stand-in." },
		botLoop: heldBackFromBots,
	},
});

export const managesWithoutAsking = define({
	"chats.setResolved": {
		http: { kind: "offered", endpoint: "chats.markResolved" },
		botLoop: resolveChatTool,
	},
	"chats.rename": {
		http: { kind: "offered", endpoint: "chats.renameChat" },
		botLoop: {
			kind: "offered",
			tool: "rename_chat",
			offeredIn: "chatBounds",
			// Managing a project in chat bounds without the asker's approval.
			// @ts-expect-error TS2322 [Type '"never"' is not assignable to type '"always"']
			approval: { kind: "never" },
		},
	},
	"events.followChat": {
		http: { kind: "heldBack", reason: "Stand-in." },
		botLoop: {
			kind: "offered",
			tool: "follow_chat",
			offeredIn: "ownChats",
			// A bot's own settings changed in its own chats by tool access, not the asker.
			// @ts-expect-error TS2322 [Type '"byToolAccess"' is not assignable to type '"always"']
			approval: { kind: "byToolAccess" },
		},
	},
});
