import {
	type BotParticipant,
	type CurrentUser,
	MESSAGE_MAX_LENGTH,
	type MessageReplyTo,
} from "@sugabots/contracts";
import { isApiFailure } from "@sugabots/sdk";
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { useSendMessage } from "@/lib/chats.ts";
import {
	type ComposerAttachments,
	type FilesForSending,
	isFileGoneRefusal,
} from "@/lib/composer-attachments.ts";
import {
	recordSending,
	restoreLatest,
	settleNotSent,
	settleSent,
	useUnsentMessages,
} from "@/lib/unsent-messages.ts";
import type { ChatRecipients } from "./chat-recipients.ts";

/** Sending the draft, as the composer shows it; see `useMessageSending`. */
export interface MessageSending {
	/**
	 * Sends the draft, clearing it. One that does not go comes back whole,
	 * once the composer is empty.
	 */
	submit: () => Promise<void>;
	/** Whether a message is on its way. */
	pending: boolean;
	/** Why the last message was not sent, to show under the composer. */
	error: string | undefined;
}

/**
 * Sends the draft, with the reply it answers and its files, to the bots it is
 * for. The bots it goes to but does not name are named at its start, so it
 * shows who it was for, and they are asked as any named bot is. The chat goes
 * to its latest message as it goes.
 *
 * A message that is not sent is kept as it was: its text, the reply it
 * answers, its files, the bots it went to and its retry key, beside the draft,
 * so it outlasts leaving the chat as the draft does; its files do not, as
 * leaving removes them. It comes back to the composer as soon as the composer
 * is empty, so nothing written meanwhile is mixed into it, and sending it
 * again unchanged sends it as it went, to the same bots under the same key.
 */
export function useMessageSending({
	chatId,
	signedIn,
	draft,
	setDraft,
	replyingTo,
	setReplyingTo,
	attachments,
	recipients,
	scrollToLatest,
}: {
	chatId: string;
	signedIn: CurrentUser;
	draft: string;
	setDraft: Dispatch<SetStateAction<string>>;
	replyingTo: MessageReplyTo | undefined;
	setReplyingTo: Dispatch<SetStateAction<MessageReplyTo | undefined>>;
	attachments: Pick<ComposerAttachments, "items" | "takeForSending">;
	recipients: Pick<ChatRecipients, "named" | "answering">;
	scrollToLatest: () => void;
}): MessageSending {
	const send = useSendMessage(chatId, signedIn);
	const [startError, setStartError] = useState<string>();
	const memberId = signedIn.id;
	const unsent = useUnsentMessages(memberId, chatId);
	/**
	 * The files each message not sent took, and why it was not sent, by its
	 * retry key, while the chat is open: leaving it removes the files.
	 */
	const takenFiles = useRef(new Map<string, { files: FilesForSending; failure: unknown }>());
	const open = useRef(true);
	/** Why the message put back in the composer was not sent. */
	const [putBackAfter, setPutBackAfter] = useState<unknown>();
	const composerEmpty =
		draft.trim() === "" && replyingTo === undefined && attachments.items.length === 0;
	const waiting = unsent.waiting.at(-1);

	useEffect(() => {
		open.current = true;
		return () => {
			open.current = false;
		};
	}, []);

	useEffect(() => {
		if (!waiting || !composerEmpty || send.isPending) return;
		restoreLatest(memberId, chatId, waiting);
		setDraft(waiting.draft);
		setReplyingTo(waiting.replyingTo);
		const taken = takenFiles.current.get(waiting.sent.retryKey);
		takenFiles.current.delete(waiting.sent.retryKey);
		taken?.files.putBack(taken.failure);
		setPutBackAfter(taken?.failure ?? NOT_HEARD_BACK);
	}, [waiting, composerEmpty, send.isPending, memberId, chatId, setDraft, setReplyingTo]);

	async function submit() {
		if (send.isPending) return;
		setStartError(undefined);
		setPutBackAfter(undefined);
		const restored = unsent.restored;
		// The bots it goes to are those the composer shows: for a message put
		// back, those it went to until the member changes them.
		const bots = unnamedBots(recipients);
		const unchanged =
			restored !== undefined &&
			restored.draft === draft &&
			restored.replyingTo?.id === replyingTo?.id &&
			sameIds(bots, restored.sent.bots);
		const message = unchanged ? restored.sent.message : withBotsNamed(draft.trim(), bots);
		if (message.length > MESSAGE_MAX_LENGTH) {
			setStartError(
				"With the bots it's sent to named, this message is too long. Shorten it a little.",
			);
			return;
		}
		const files = attachments.takeForSending(draft);
		if (!files) return;
		const sameFiles = unchanged && sameIds(files.parts, restored.sent.files);
		// Sent again as it went, to the same bots under the same key, unless
		// the member changed it: the first may have arrived, its answer lost.
		const retryKey = unchanged && sameFiles ? restored.sent.retryKey : uuidv4();
		// Recorded before the composer is cleared, and settled by the request
		// whether or not the chat is still open, so leaving loses nothing.
		recordSending(memberId, chatId, {
			draft,
			...(replyingTo ? { replyingTo } : {}),
			sent: { retryKey, message, bots, files: files.parts },
		});
		setDraft("");
		setReplyingTo(undefined);
		try {
			const sending = send.mutateAsync({
				retryKey,
				message,
				replyTo: replyingTo,
				files: files.parts,
			});
			scrollToLatest();
			await sending;
			settleSent(memberId, chatId, retryKey);
			scrollToLatest();
		} catch (failure) {
			settleNotSent(memberId, chatId, retryKey);
			if (open.current) takenFiles.current.set(retryKey, { files, failure });
			// Left, the files go: putting them back removes them.
			else files.putBack(failure);
		}
	}

	return {
		submit,
		pending: send.isPending,
		error:
			startError ??
			(waiting
				? UNSENT_WAITING
				: putBackAfter !== undefined
					? sendFailureMessage(putBackAfter)
					: undefined),
	};
}

/** Why a message put back after the chat was left was not sent: nothing says, only that it wasn't. */
const NOT_HEARD_BACK = new Error("The message was not heard to be sent");

/** Under the composer while a message that was not sent waits for it to be empty. */
const UNSENT_WAITING =
	"Message not sent. It comes back here once you send or clear what you're writing.";

/** Whether `left` and `right` hold the same things, by id, in the same order. */
function sameIds(left: readonly { id: string }[], right: readonly { id: string }[]): boolean {
	return left.length === right.length && left.every((item, index) => item.id === right[index]?.id);
}

/** The bots the message goes to that the draft does not name. */
function unnamedBots({
	named,
	answering,
}: {
	named: readonly BotParticipant[];
	answering: readonly BotParticipant[];
}): BotParticipant[] {
	return answering.filter((bot) => !named.includes(bot));
}

/** `message` with `bots`, which it goes to but does not name, named at its start. */
function withBotsNamed(message: string, bots: readonly BotParticipant[]): string {
	return bots.length > 0 ? `${bots.map((bot) => `@${bot.handle}`).join(" ")} ${message}` : message;
}

/**
 * Under the composer when a message is not sent. A file that was gone comes
 * back as a failed chip to retry; any other refusal says what to change.
 */
function sendFailureMessage(failure: unknown): string {
	if (isFileGoneRefusal(failure)) {
		return "Message not sent. Some files were no longer there. Retry them to send.";
	}
	if (isApiFailure(failure) && failure._tag === "BadRequest") {
		return `Message not sent. ${failure.message}.`;
	}
	return "Message not sent. Your draft is still here.";
}
