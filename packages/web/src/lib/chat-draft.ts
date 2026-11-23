import { type MessageReplyTo, messageReplyToSchema } from "@sugabots/contracts";
import { Option, Schema } from "effect";
import { type Dispatch, type SetStateAction, useEffect, useState } from "react";

/**
 * The unsent message in one person's chat, kept in localStorage
 * so it survives switching chats, projects, or reloading. A blank draft removes
 * its key, so only chats with something waiting to be sent take up room. Two
 * tabs on the same chat do not sync; whichever wrote last is what comes back.
 */
export function useChatDraft(
	personId: string,
	chatId: string,
): [string, Dispatch<SetStateAction<string>>] {
	const key = draftKey(personId, chatId);
	const [draft, setDraft] = useState(() => read(key));

	useEffect(() => {
		write(key, draft);
	}, [key, draft]);

	return [draft, setDraft];
}

/**
 * The message the unsent draft in the same chat answers, kept beside it as
 * `useChatDraft` keeps the draft. A stored value that no longer reads as a
 * quote is dropped.
 */
export function useReplyDraft(
	personId: string,
	chatId: string,
): [MessageReplyTo | undefined, Dispatch<SetStateAction<MessageReplyTo | undefined>>] {
	const key = `sugabots-draft-reply:${draftPlace(personId, chatId)}`;
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
	personId: string,
	chatId: string,
): [TakenOffRecipients, Dispatch<SetStateAction<TakenOffRecipients>>] {
	const key = `sugabots-draft-taken-off:${draftPlace(personId, chatId)}`;
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

type TakenOffRecipients = typeof takenOffRecipientsSchema.Type;

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
function draftKey(personId: string, chatId: string): string {
	return `sugabots-draft:${draftPlace(personId, chatId)}`;
}

/** Whose draft in which chat a stored key holds. A chat's id is unique across projects. */
function draftPlace(personId: string, chatId: string): string {
	return `${personId}:${chatId}`;
}
