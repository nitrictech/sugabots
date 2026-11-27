export * as Audience from "./audience.ts";

import type { ReachChange, StreamEvent } from "@sugabots/contracts";

/**
 * Who may hear an event on a workspace's stream. Everyone in the workspace
 * follows it, but each event names who it is for, and a stream sends it only
 * to a member its last proof says is among them:
 *
 * - `chat`: those who reach the chat, which is reaching its project (a
 *   system chat, in no project, is reached by nobody);
 * - `project`: for an event about no chat, those who reach its project;
 * - `bot`: for an event about a bot, those who reach the bot;
 * - `workspace`: for an event about anything everyone in the workspace sees,
 *   such as a membership or a setting.
 *
 * An event on a workspace's stream that names nobody is sent to nobody. The
 * audience rides along in the stored event, under the field below; the stream
 * reads it and takes it off before sending.
 *
 * A notification on a member's own stream names its chat, or the approval it
 * asks them to decide (`approval`: the call, the approval it was asked for,
 * and whether it shows the call's chat), and their stream sends it only while
 * they still reach that chat, or while that approval still waits and they can
 * decide it. A call asked about again has a new approval, so a notification
 * for an earlier one is not sent. One that names neither, such as a test, is
 * always sent.
 */
export type Group =
	| { readonly kind: "chat"; readonly chat: string }
	| { readonly kind: "project"; readonly project: string }
	| { readonly kind: "bot"; readonly bot: string }
	| {
			readonly kind: "approval";
			readonly toolCall: string;
			readonly approval: string;
			readonly showsChat: boolean;
	  }
	| { readonly kind: "workspace" };

const FIELD = "audience";

/** Where events stored before audiences had kinds name their chat. */
const CHAT_FIELD = "audienceChatId";

/** `event`, to be heard only by `audience`. */
export const addressedTo = <Event extends StreamEvent>(audience: Group, event: Event): Event => ({
	...event,
	[FIELD]: audience,
});

/** `event`, to be heard only by members who reach the chat `chatId`. */
export const forChat = <Event extends StreamEvent>(chatId: string, event: Event): Event =>
	addressedTo({ kind: "chat", chat: chatId }, event);

/** `event`, to be heard only by members who reach the project `projectId`. */
export const forProject = <Event extends StreamEvent>(projectId: string, event: Event): Event =>
	addressedTo({ kind: "project", project: projectId }, event);

/** `event`, to be heard only by members who reach the bot `botId`. */
export const forBot = <Event extends StreamEvent>(botId: string, event: Event): Event =>
	addressedTo({ kind: "bot", bot: botId }, event);

/** `event`, to be heard by everyone in the workspace. */
export const forWorkspace = <Event extends StreamEvent>(event: Event): Event =>
	addressedTo({ kind: "workspace" }, event);

/**
 * Who hears a change of who reaches what: a membership is seen by everyone in
 * the workspace, a project's members and bots by those who reach it, a bot by
 * those who reach it, or did until its deletion began. Others who stopped
 * reaching it are not told, but their streams prove again on it all the same.
 */
export function ofReachChange(about: ReachChange): Group {
	switch (about.kind) {
		case "membership":
		case "workspace":
			return { kind: "workspace" };
		case "project":
			return { kind: "project", project: about.projectId };
		case "bot":
			return { kind: "bot", bot: about.botId };
	}
}

/**
 * Who alone may hear `event`, if it names anybody, and the event as clients
 * see it, without the fields that say so.
 */
export function read(event: StreamEvent): {
	readonly audience: Group | undefined;
	readonly event: StreamEvent;
} {
	const { [FIELD]: named, [CHAT_FIELD]: chatId, ...delivered }: StreamEvent = event;
	const audience =
		parse(named) ??
		(typeof chatId === "string" ? { kind: "chat" as const, chat: chatId } : undefined);
	return { audience, event: delivered as StreamEvent };
}

/** `stored` as an audience, or `undefined` when it isn't one. */
function parse(stored: unknown): Group | undefined {
	if (typeof stored !== "object" || stored === null || !("kind" in stored)) return undefined;
	const fields: { readonly [field: string]: unknown } = stored;
	switch (fields.kind) {
		case "workspace":
			return { kind: "workspace" };
		case "chat":
			return typeof fields.chat === "string" ? { kind: "chat", chat: fields.chat } : undefined;
		case "project":
			return typeof fields.project === "string"
				? { kind: "project", project: fields.project }
				: undefined;
		case "bot":
			return typeof fields.bot === "string" ? { kind: "bot", bot: fields.bot } : undefined;
		case "approval":
			return typeof fields.toolCall === "string" &&
				typeof fields.approval === "string" &&
				typeof fields.showsChat === "boolean"
				? {
						kind: "approval",
						toolCall: fields.toolCall,
						approval: fields.approval,
						showsChat: fields.showsChat,
					}
				: undefined;
		default:
			return undefined;
	}
}
