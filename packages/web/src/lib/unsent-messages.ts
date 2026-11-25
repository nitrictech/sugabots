import {
	type BotParticipant,
	botParticipantSchema,
	filePartSchema,
	messageReplyToSchema,
} from "@sugabots/contracts";
import { Option, Schema } from "effect";
import { useSyncExternalStore } from "react";

/**
 * A message sent from the composer that the API was not heard to have: what
 * the composer held, and what went, its bots and retry key included.
 */
const unsentMessageSchema = Schema.Struct({
	draft: Schema.String,
	replyingTo: Schema.optional(messageReplyToSchema),
	sent: Schema.Struct({
		retryKey: Schema.String,
		/** The text as sent, naming the bots it went to. */
		message: Schema.String,
		/** The bots it went to without the member naming them. */
		bots: Schema.Array(botParticipantSchema),
		files: Schema.Array(filePartSchema),
	}),
});

export type UnsentMessage = typeof unsentMessageSchema.Type;

const storedSchema = Schema.Struct({
	/** Sent, and not yet answered when last written. */
	sending: Schema.Array(unsentMessageSchema),
	/** Not sent, waiting for the composer to be empty, the latest last. */
	waiting: Schema.Array(unsentMessageSchema),
	/** The one put back in the composer, which sending unchanged sends again as it went. */
	restored: Schema.optional(unsentMessageSchema),
	/** The bots the member chose since for the restored one to go to without naming them. */
	restoredBots: Schema.optional(Schema.Array(botParticipantSchema)),
});

type Stored = typeof storedSchema.Type;

/** One member's unsent messages in one chat, as the composer shows them. */
export interface UnsentMessages {
	/**
	 * Those waiting to come back to the composer, the latest last: those not
	 * sent, and those whose sending this tab no longer follows, as after a
	 * reload, whose answer was never heard.
	 */
	readonly waiting: readonly UnsentMessage[];
	readonly restored: UnsentMessage | undefined;
	/**
	 * The bots the restored message goes to without naming them: those it went
	 * to, until the member chooses others.
	 */
	readonly restoredBots: readonly BotParticipant[] | undefined;
}

/**
 * The messages one member sent in one chat that the API was not heard to
 * have, kept in localStorage beside the chat's draft, so they survive
 * switching chats or reloading as the draft does.
 *
 * A message is recorded before the composer is cleared, and settled by its
 * request, whether or not the chat is still open when it answers.
 */
export function useUnsentMessages(memberId: string, chatId: string): UnsentMessages {
	const key = keyOf(memberId, chatId);
	const stored = useSyncExternalStore(
		(listener) => subscribe(key, listener),
		() => readStored(key),
	);
	return {
		waiting: [
			...stored.waiting,
			...stored.sending.filter((one) => !followed.has(one.sent.retryKey)),
		],
		restored: stored.restored,
		restoredBots: stored.restoredBots ?? stored.restored?.sent.bots,
	};
}

/** Records `message` as sent and not yet answered, in place of any restored one. */
export function recordSending(memberId: string, chatId: string, message: UnsentMessage): void {
	followed.add(message.sent.retryKey);
	update(keyOf(memberId, chatId), (stored) => ({
		sending: [...stored.sending, message],
		waiting: stored.waiting,
	}));
}

/** Forgets the message sent under `retryKey`, which the API has. */
export function settleSent(memberId: string, chatId: string, retryKey: string): void {
	followed.delete(retryKey);
	update(keyOf(memberId, chatId), (stored) => ({
		...stored,
		sending: stored.sending.filter((one) => one.sent.retryKey !== retryKey),
		waiting: stored.waiting.filter((one) => one.sent.retryKey !== retryKey),
	}));
}

/** Moves the message sent under `retryKey`, which the API refused or never answered, to wait. */
export function settleNotSent(memberId: string, chatId: string, retryKey: string): void {
	followed.delete(retryKey);
	update(keyOf(memberId, chatId), (stored) => {
		const settled = stored.sending.find((one) => one.sent.retryKey === retryKey);
		if (!settled) return stored;
		return {
			...stored,
			sending: stored.sending.filter((one) => one !== settled),
			waiting: [...stored.waiting, settled],
		};
	});
}

/** Puts the latest waiting message back in the composer, as the restored one. */
export function restoreLatest(memberId: string, chatId: string, message: UnsentMessage): void {
	const retryKey = message.sent.retryKey;
	update(keyOf(memberId, chatId), (stored) => ({
		sending: stored.sending.filter((one) => one.sent.retryKey !== retryKey),
		waiting: stored.waiting.filter((one) => one.sent.retryKey !== retryKey),
		restored: message,
	}));
}

/** Sends the restored message to `bots`, which the member chose, rather than those it went to. */
export function chooseRestoredBots(
	memberId: string,
	chatId: string,
	bots: readonly BotParticipant[],
): void {
	update(keyOf(memberId, chatId), (stored) =>
		stored.restored ? { ...stored, restoredBots: [...bots] } : stored,
	);
}

/** The retry keys of the messages whose requests this tab is waiting on. */
const followed = new Set<string>();

const listeners = new Map<string, Set<() => void>>();

function subscribe(key: string, listener: () => void): () => void {
	const forKey = listeners.get(key) ?? new Set();
	forKey.add(listener);
	listeners.set(key, forKey);
	return () => forKey.delete(listener);
}

const EMPTY: Stored = { sending: [], waiting: [] };

/** The last value read for each key, by the text it was read from, so a read changes only with it. */
const read = new Map<string, { text: string; stored: Stored }>();

/** Kept here too, for when storage is off, so the messages still last while the tab is open. */
const unstorable = new Map<string, Stored>();

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(storedSchema));

function readStored(key: string): Stored {
	const kept = unstorable.get(key);
	if (kept) return kept;
	let text = "";
	try {
		text = localStorage.getItem(key) ?? "";
	} catch {
		return EMPTY;
	}
	const cached = read.get(key);
	if (cached?.text === text) return cached.stored;
	const stored = Option.getOrElse(text ? decode(text) : Option.none(), () => EMPTY);
	read.set(key, { text, stored });
	return stored;
}

function update(key: string, change: (stored: Stored) => Stored): void {
	const next = change(readStored(key));
	const empty = next.sending.length === 0 && next.waiting.length === 0 && !next.restored;
	try {
		if (empty) localStorage.removeItem(key);
		else localStorage.setItem(key, JSON.stringify(next));
		unstorable.delete(key);
	} catch {
		unstorable.set(key, next);
	}
	for (const listener of listeners.get(key) ?? []) listener();
}

function keyOf(memberId: string, chatId: string): string {
	return `sugabots-draft-unsent:${memberId}:${chatId}`;
}
