import {
	type CollaborationPart,
	isAttached,
	isNarration,
	type Message,
	type ToolCallPart,
} from "@sugabots/contracts";
import { awaitsApproval } from "./tool-activity.ts";

/*
 * How a thread lays its messages out: which parts of a message are drawn
 * among its bubbles, which messages head a group under their author's face
 * and name, where a new day is marked, and which face comes alive for the bot
 * answering.
 */

/** Where the face of the bot answering is drawn, and whether it's typing now. */
export interface AnsweringFace {
	messageId: string;
	botTyping: boolean;
}

/**
 * The face that stands for the bot that wrote the newest message: the last
 * face drawn for that bot. A reply just begun shows only as its typing line,
 * so its face may be on the bot's reply before.
 */
export function findAnsweringFace(
	messages: readonly Message[],
	dividers: boolean,
): AnsweringFace | undefined {
	const newest = messages.at(-1);
	if (newest?.author.kind !== "agent") return undefined;
	const drawn = messages.findLast(
		(message, index) =>
			sameAuthor(message, newest) &&
			startsRun(messages[index - 1], message, dividers) &&
			!showsNothingYet(message),
	);
	return drawn && { messageId: drawn.id, botTyping: isTyping(newest) };
}

/** Whether `message` heads a run drawn with its author's face: after a day marker, or as `startsGroup` says. */
export function startsRun(
	previous: Message | undefined,
	message: Message,
	dividers: boolean,
): boolean {
	return (
		(dividers && startsNewDay(previous?.createdAt, message.createdAt)) ||
		startsGroup(previous, message)
	);
}

/**
 * Whether `message` heads a group of its own, with its author's face and name:
 * a new author, an hour's quiet, a reply, whose quote sits over its author's
 * name, or a message after one that opened a collaboration, whose thread line
 * ends that group.
 */
export function startsGroup(previous: Message | undefined, message: Message): boolean {
	if (!previous || !sameAuthor(previous, message) || message.replyTo) return true;
	if (previous.parts.some((part) => part.type === "collaboration")) return true;
	return (
		new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() >= LONG_QUIET_MS
	);
}

/**
 * Whether a reply's turn is still going, so the typing line stands in for it.
 * A call waiting to be approved has its own card saying the turn is stopped on
 * it, and the line would say the same thing twice.
 */
export function isTyping(message: Message): boolean {
	// While a collaboration runs the bot is quiet in its own chat; the collaboration line says so.
	if (waitingOn(message)) return false;
	const awaitingApproval = message.parts.some(
		(part) => part.type === "tool_call" && awaitsApproval(part),
	);
	return message.status === "streaming" && !awaitingApproval;
}

/** The collaborator a running reply has asked and not yet heard back from. */
export function waitingOn(message: Message): string | undefined {
	const last = message.parts.at(-1);
	return last?.type === "collaboration" ? last.agentName : undefined;
}

/** Whether a person was asked to allow the call, rather than policy allowing it on its own. */
function wasPutToSomeone(call: ToolCallPart): boolean {
	const status = call.approval?.status;
	return status === "pending" || status === "allowed" || status === "denied";
}

export type Segment =
	| { type: "text"; key: string; text: string }
	| { type: "collaboration"; key: string; collaboration: CollaborationPart }
	| { type: "tool_call"; key: string; toolCall: ToolCallPart };

/** Whether a reply being written has nothing settled to show yet, so shows only as its typing line. */
export function showsNothingYet(message: Message): boolean {
	if (message.status !== "streaming") return false;
	const shows =
		message.parts.some((part) => part.type === "tool_call" || part.type === "file") ||
		segmentsOf(message).some((segment) => segment.type !== "text" || segment.text);
	return !shows;
}

/**
 * The message's parts as things to draw, leaving out narration and every tool
 * call but those somebody was asked to approve. A reply still being written shows
 * only those, its collaborations, and text that something has followed: the
 * run it is still writing waits until it is finished.
 */
export function segmentsOf(message: Message): Segment[] {
	const finished = message.status !== "streaming";
	// A text run is keyed by where in the message it starts; a collaboration or
	// tool call by its id.
	let written = 0;
	const segments: Segment[] = [];
	message.parts.forEach((part, index) => {
		if (part.type === "collaboration") {
			segments.push({ type: "collaboration", key: part.id, collaboration: part });
			return;
		}
		if (part.type === "tool_call") {
			// A call somebody had to answer is the only one drawn among the bubbles, as its card.
			if (wasPutToSomeone(part)) segments.push({ type: "tool_call", key: part.id, toolCall: part });
			return;
		}
		// Attached files, and a routine result's artifacts, are not part of the message's text.
		if (isAttached(part)) return;
		// Files go after all of a reply's text as they are attached, so one shared
		// mid-reply does not mean the text before it is finished.
		const followed =
			part.text.trim() !== "" && message.parts.slice(index + 1).some((later) => !isAttached(later));
		const settled = finished || followed;
		if (settled && !isNarration(message.parts, index)) {
			segments.push({ type: "text", key: `text@${written}`, text: part.text });
		}
		written += part.text.length;
	});
	/*
	 * A reply that called a tool and wrote nothing has no text part at all —
	 * `messagePartsFor` adds none to empty content. It still needs a bubble: that
	 * is where its author, its time, a failure and the way into its activity all
	 * hang.
	 */
	if (finished && !segments.some((segment) => segment.type === "text")) {
		segments.push({ type: "text", key: `text@${written}`, text: "" });
	}
	return segments;
}

/** An hour without a message starts a new group, with its author's face and name again. */
const LONG_QUIET_MS = 60 * 60_000;

/** Whether `at` is the first thing shown, or falls on a new day from `previousAt`, and so wants a day marker. */
export function startsNewDay(previousAt: string | undefined, at: string): boolean {
	return previousAt === undefined || !sameDate(new Date(previousAt), new Date(at));
}

function sameAuthor(left: Message, right: Message): boolean {
	if (left.author.kind === "routine_trigger" || right.author.kind === "routine_trigger") {
		return false;
	}
	return left.author.kind === right.author.kind && left.author.id === right.author.id;
}

function shortDateFor(date: Date, now: Date): Intl.DateTimeFormatOptions {
	return date.getFullYear() === now.getFullYear()
		? { month: "short", day: "numeric" }
		: dateWithYear;
}

export const dateWithYear: Intl.DateTimeFormatOptions = {
	month: "short",
	day: "numeric",
	year: "numeric",
};

/**
 * "Today", "Yesterday", or the date in `dateFormat`: by default the month and
 * day, and the year only for another year. Days are `now`'s, by this device's
 * clock, and the date is written in `locale`, by default the browser's.
 */
export function formatDay(
	date: Date,
	{
		now = new Date(),
		locale,
		dateFormat = shortDateFor(date, now),
	}: { now?: Date; locale?: string; dateFormat?: Intl.DateTimeFormatOptions } = {},
): string {
	if (sameDate(date, now)) {
		return "Today";
	}
	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	if (sameDate(date, yesterday)) {
		return "Yesterday";
	}
	return new Intl.DateTimeFormat(locale, dateFormat).format(date);
}

export function sameDay(left: { createdAt: string }, right: { createdAt: string }): boolean {
	return sameDate(new Date(left.createdAt), new Date(right.createdAt));
}

function sameDate(left: Date, right: Date): boolean {
	return (
		left.getFullYear() === right.getFullYear() &&
		left.getMonth() === right.getMonth() &&
		left.getDate() === right.getDate()
	);
}
