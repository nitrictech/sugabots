import { type MessageReplyTo, messageReplyToSchema } from "@sugabots/contracts";
import { Option, Schema } from "effect";
import { type Dispatch, type SetStateAction, useEffect, useState } from "react";

/**
 * The unsent message in one person's chat, kept in localStorage
 * so it survives switching chats, pods, or reloading. A blank draft removes
 * its key, so only chats with something waiting to be sent take up room. Two
 * tabs on the same chat do not sync; whichever wrote last is what comes back.
 */
export function useChatDraft(
	userId: string,
	podId: string | null,
	conversationId: string,
): [string, Dispatch<SetStateAction<string>>] {
	const key = draftKey(userId, podId, conversationId);
	const [draft, setDraft] = useState(() => read(key));

	useEffect(() => {
		write(key, draft);
	}, [key, draft]);

	return [draft, setDraft];
}

/**
 * Takes the unsent draft out of one person's chat, as `useChatDraft` keeps
 * it, for it to go on elsewhere. Read before that chat is next shown, as it
 * is only read when shown.
 */
export function takeChatDraft(
	userId: string,
	podId: string | null,
	conversationId: string,
): string {
	const key = draftKey(userId, podId, conversationId);
	const draft = read(key);
	write(key, "");
	return draft;
}

/**
 * Adds `text` to the end of the unsent draft in one person's chat, as
 * `useChatDraft` keeps it. Written before that chat is next shown, as it is
 * only read when shown.
 */
export function addToChatDraft(
	userId: string,
	podId: string | null,
	conversationId: string,
	text: string,
): void {
	const key = draftKey(userId, podId, conversationId);
	write(key, joinDrafts(read(key), text));
}

/** Two drafts as one, a line apart, or whichever has words when the other is blank. */
export function joinDrafts(first: string, second: string): string {
	if (!first.trim()) return second;
	if (!second.trim()) return first;
	return `${first}\n${second}`;
}

/**
 * A chat's draft `current`, which was `before` until more was added to it
 * with `joinDrafts`, split into what was there (`kept`) and what was added
 * (`added`). Once what was there has been changed the two can no longer be
 * told apart, so all of it is kept and nothing counts as added.
 */
export function splitDraft(before: string, current: string): { kept: string; added: string } {
	if (!before.trim()) return { kept: "", added: current };
	if (current === before) return { kept: before, added: "" };
	if (current.startsWith(`${before}\n`)) {
		return { kept: before, added: current.slice(before.length + 1) };
	}
	return { kept: current, added: "" };
}

/**
 * The message the unsent draft in the same chat answers, kept beside it as
 * `useChatDraft` keeps the draft. A stored value that no longer reads as a
 * quote is dropped.
 */
export function useChatReplyDraft(
	userId: string,
	podId: string | null,
	conversationId: string,
): [MessageReplyTo | undefined, Dispatch<SetStateAction<MessageReplyTo | undefined>>] {
	const key = `sugabots-draft-reply:${draftPlace(userId, podId, conversationId)}`;
	const [replyTo, setReplyTo] = useState(() => decodeReplyTo(read(key)));

	useEffect(() => {
		write(key, replyTo ? JSON.stringify(replyTo) : "");
	}, [key, replyTo]);

	return [replyTo, setReplyTo];
}

/**
 * The bots taken off the unsent draft in the same chat, of those its last
 * message went to, kept beside it as `useChatDraft` keeps the draft. `after`
 * is that last message: once another is sent, none is taken off.
 */
export function useTakenOffRecipients(
	userId: string,
	podId: string | null,
	conversationId: string,
): [TakenOffRecipients, Dispatch<SetStateAction<TakenOffRecipients>>] {
	const key = `sugabots-draft-taken-off:${draftPlace(userId, podId, conversationId)}`;
	const [takenOff, setTakenOff] = useState(() => decodeTakenOff(read(key)));

	useEffect(() => {
		write(key, takenOff.botIds.length > 0 ? JSON.stringify(takenOff) : "");
	}, [key, takenOff]);

	return [takenOff, setTakenOff];
}

const takenOffRecipientsSchema = Schema.Struct({
	after: Schema.optional(Schema.String),
	botIds: Schema.Array(Schema.String),
});

export type TakenOffRecipients = typeof takenOffRecipientsSchema.Type;

const decodeStoredTakenOff = Schema.decodeUnknownOption(
	Schema.fromJsonString(takenOffRecipientsSchema),
);

function decodeTakenOff(stored: string): TakenOffRecipients {
	return Option.getOrElse(stored ? decodeStoredTakenOff(stored) : Option.none(), () => ({
		botIds: [],
	}));
}

const decodeStoredReplyTo = Schema.decodeUnknownOption(Schema.fromJsonString(messageReplyToSchema));

function decodeReplyTo(stored: string): MessageReplyTo | undefined {
	return stored ? Option.getOrUndefined(decodeStoredReplyTo(stored)) : undefined;
}

function read(key: string): string {
	try {
		return localStorage.getItem(key) ?? "";
	} catch {
		return "";
	}
}

function write(key: string, value: string): void {
	try {
		if (value.trim()) {
			localStorage.setItem(key, value);
		} else {
			localStorage.removeItem(key);
		}
	} catch {
		// Storage can be off. The draft still lasts while the chat is open.
	}
}

/** Where `useChatDraft` keeps one person's draft in one chat. */
function draftKey(userId: string, podId: string | null, conversationId: string): string {
	return `sugabots-draft:${draftPlace(userId, podId, conversationId)}`;
}

/**
 * Whose draft in which chat a stored key holds: the person's, in the
 * conversation, under its pod; a direct message between people is in none.
 */
function draftPlace(userId: string, podId: string | null, conversationId: string): string {
	return [userId, ...(podId === null ? [] : [podId]), conversationId].join(":");
}
