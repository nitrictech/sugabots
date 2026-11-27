/**
 * Near-misses with the exposure manifest, one per entry under
 * `@ts-expect-error`. Type-checked and never run or imported. The lint check
 * reads each directive's TS code and bracketed message fragment to verify
 * that the line fails for the intended reason.
 *
 * The operations here are stand-ins.
 */

import { Schema } from "effect";
import { type BotLoopDecision, checkExposure, type HttpDecision } from "./exposure.ts";
import { OperationContract } from "./operation.ts";

/** A stand-in for resolving a chat, with the decisions given. */
const setResolved = <const Http extends HttpDecision, const BotLoop extends BotLoopDecision>(
	http: Http,
	botLoop: BotLoop,
) =>
	OperationContract.make("chats.setResolved", {
		description: "Mark this chat resolved, or reopen it.",
		input: Schema.Struct({ chatId: Schema.String, resolved: Schema.Boolean }),
		output: Schema.Void,
		errors: [],
		changes: true,
		http,
		botLoop,
	});

/** A stand-in for renaming a chat, with the decisions given. */
const rename = <const Http extends HttpDecision, const BotLoop extends BotLoopDecision>(
	http: Http,
	botLoop: BotLoop,
) =>
	OperationContract.make("chats.rename", {
		description: "Rename this chat.",
		input: Schema.Struct({ chatId: Schema.String, name: Schema.String }),
		output: Schema.Void,
		errors: [],
		changes: true,
		http,
		botLoop,
	});

const resolvedAt = { kind: "offered", method: "PUT", path: "/chats/:chatId/resolved" } as const;
const nameAt = { kind: "offered", method: "PUT", path: "/chats/:chatId/name" } as const;
const heldBackFromBots = {
	kind: "heldBack",
	reason: "Stand-in: a bot reads its chat in its turn.",
} as const;
const resolveChatTool = {
	kind: "offered",
	tool: "resolve_chat",
	offeredIn: "everywhere",
	approval: { kind: "never" },
	personalBotAsks: true,
} as const;
declare const computedReason: string;

export const sound = checkExposure({
	"chats.setResolved": setResolved(resolvedAt, resolveChatTool),
	"chats.rename": rename(nameAt, {
		kind: "coveredBy",
		operation: "chats.setResolved",
		reason: "Stand-in: a covered operation names one offered directly.",
	}),
});

// No decision for the bot loop.
// @ts-expect-error TS2741 [Property 'botLoop' is missing]
export const missingDecision = OperationContract.make("chats.rename", {
	description: "Rename this chat.",
	input: Schema.Struct({ chatId: Schema.String, name: Schema.String }),
	output: Schema.Void,
	errors: [],
	changes: true,
	http: nameAt,
});

// `heldBack` with no reason.
// @ts-expect-error TS2345 [Property 'reason' is missing]
export const noReason = rename({ kind: "heldBack" }, heldBackFromBots);

export const blankReason = checkExposure({
	"chats.setResolved": setResolved(resolvedAt, resolveChatTool),
	// `heldBack` with a blank reason.
	// @ts-expect-error TS2322 [Property '"a decision that holds back an operation, serves it at its own endpoint or covers it needs its reason]
	"chats.rename": rename({ kind: "heldBack", reason: "  " }, heldBackFromBots),
});

export const typedReason = checkExposure({
	"chats.setResolved": setResolved(resolvedAt, resolveChatTool),
	// An endpoint of its own, for a reason typed as `string`, which nobody wrote here.
	// @ts-expect-error TS2322 [Property '"a decision that holds back an operation, serves it at its own endpoint or covers it needs its reason]
	"chats.rename": rename({ kind: "ownEndpoint", reason: computedReason }, heldBackFromBots),
});

export const covers = checkExposure({
	// Covered by an operation that isn't registered.
	// @ts-expect-error TS2322 [Property '"covered by an operation the bot loop must offer directly: not this o]
	"chats.setResolved": setResolved(resolvedAt, {
		kind: "coveredBy",
		operation: "chats.unknown",
		reason: "Stand-in.",
	}),
	// Covered by an operation the bot loop doesn't offer directly.
	// @ts-expect-error TS2322 [Property '"covered by an operation the bot loop must offer directly: not this o]
	"chats.rename": rename(nameAt, {
		kind: "coveredBy",
		operation: "chats.setResolved",
		reason: "Stand-in.",
	}),
});

export const unfitPath = checkExposure({
	"chats.setResolved": setResolved(resolvedAt, resolveChatTool),
	// A path parameter the input has no field for.
	// @ts-expect-error TS2322 [Property '"offered over HTTP: its path must be plain segments and `:name` parameters, and its input a struct with a field for each parameter"']
	"chats.rename": rename({ ...nameAt, path: "/chats/:chat/name" }, heldBackFromBots),
});

export const dottedParameter = checkExposure({
	"chats.setResolved": setResolved(resolvedAt, resolveChatTool),
	// A parameter the router reads as `name` and a literal `.json`, though the input has a field `name.json`.
	// @ts-expect-error TS2322 [Property '"offered over HTTP: its path must be plain segments and `:name` parameters, and its input a struct with a field for each parameter"']
	"files.download": OperationContract.make("files.download", {
		description: "Download a file by its name.",
		input: Schema.Struct({ "name.json": Schema.String }),
		output: Schema.Void,
		errors: [],
		changes: false,
		http: { kind: "offered", method: "GET", path: "/files/:name.json" },
		botLoop: heldBackFromBots,
	}),
});

export const emptySegment = checkExposure({
	"chats.setResolved": setResolved(resolvedAt, resolveChatTool),
	// An empty segment, which the router reads the same as none.
	// @ts-expect-error TS2322 [Property '"offered over HTTP: its path must be plain segments and `:name` parameters, and its input a struct with a field for each parameter"']
	"chats.rename": rename({ ...nameAt, path: "/chats//:chatId/name" }, heldBackFromBots),
});

export const changingGet = checkExposure({
	"chats.setResolved": setResolved(resolvedAt, resolveChatTool),
	// An operation that changes something, offered as a GET.
	// @ts-expect-error TS2322 [Property '"changes something, so it can't be offered as a GET]
	"chats.rename": rename({ ...nameAt, method: "GET" }, heldBackFromBots),
});

// Two operations offered at one method and path.
// @ts-expect-error TS2345 [Property '"one operation per method and path: these operations are offered at the same one"']
export const sharedRoute = checkExposure({
	"chats.setResolved": setResolved(resolvedAt, resolveChatTool),
	"chats.rename": rename({ ...nameAt, path: "/chats/:chatId/resolved" }, heldBackFromBots),
});

export const misfiled = checkExposure({
	// A contract filed under another operation's name.
	// @ts-expect-error TS2322 [Type '"chats.setResolved"' is not assignable to type '"chats.rename"']
	"chats.rename": setResolved(resolvedAt, resolveChatTool),
});

// A tool that doesn't say in which bounds it is offered.
// @ts-expect-error TS2345 [is not assignable to parameter of type 'BotLoopDecision']
export const unbounded = rename(nameAt, {
	kind: "offered",
	tool: "rename_chat",
	approval: { kind: "never" },
	personalBotAsks: true,
});

export const managesWithoutAsking = rename(nameAt, {
	kind: "offered",
	tool: "rename_chat",
	offeredIn: "chatBounds",
	// Managing a project in chat bounds without the asker's approval.
	// @ts-expect-error TS2322 [Type '"never"' is not assignable to type '"always"']
	approval: { kind: "never" },
	personalBotAsks: true,
});

export const ownChatsByToolAccess = rename(nameAt, {
	kind: "offered",
	tool: "rename_chat",
	offeredIn: "ownChats",
	// A bot's own settings changed in its own chats by tool access, not the asker.
	// @ts-expect-error TS2322 [Type '"byToolAccess"' is not assignable to type '"always"']
	approval: { kind: "byToolAccess" },
	personalBotAsks: true,
});

const resolveById = OperationContract.make("chats.resolveById", {
	description: "Mark this chat resolved by its id.",
	input: Schema.Struct({ id: Schema.String, resolved: Schema.Boolean }),
	output: Schema.Void,
	errors: [],
	changes: true,
	http: { kind: "offered", method: "PUT", path: "/CHATS/:id/resolved" },
	botLoop: heldBackFromBots,
});

// @ts-expect-error TS2345 [Property '"one operation per method and path: these operations are offered at the same one"']
export const sharedRoutePattern = checkExposure({
	"chats.setResolved": setResolved(resolvedAt, resolveChatTool),
	"chats.resolveById": resolveById,
});
