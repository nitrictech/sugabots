import {
	type BotParticipant,
	MESSAGE_MAX_LENGTH,
	type MessageReplyTo,
	type SessionUser,
} from "@sugabots/contracts";
import { isApiFailure } from "@sugabots/sdk";
import { type Dispatch, type SetStateAction, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { useSendMessage } from "@/lib/chats.ts";
import { type ComposerAttachments, isFileGoneRefusal } from "@/lib/composer-attachments.ts";
import type { ChatRecipients } from "./chat-recipients.ts";

/** Sending the draft, as the composer shows it; see `useMessageSending`. */
export interface MessageSending {
	/** Sends the draft, clearing it, and puts it back if it does not go. */
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
 */
export function useMessageSending({
	conversationId,
	user,
	draft,
	setDraft,
	replyingTo,
	setReplyingTo,
	attachments,
	recipients,
	scrollToLatest,
}: {
	conversationId: string;
	user: SessionUser;
	draft: string;
	setDraft: Dispatch<SetStateAction<string>>;
	replyingTo: MessageReplyTo | undefined;
	setReplyingTo: Dispatch<SetStateAction<MessageReplyTo | undefined>>;
	attachments: Pick<ComposerAttachments, "takeForSending">;
	recipients: Pick<ChatRecipients, "named" | "answering">;
	scrollToLatest: () => void;
}): MessageSending {
	const send = useSendMessage(conversationId, user);
	const [startError, setStartError] = useState<string>();

	async function submit() {
		if (send.isPending) return;
		setStartError(undefined);
		const message = draft.trim();
		const addressedMessage = withUnnamedBots(message, recipients);
		if (addressedMessage.length > MESSAGE_MAX_LENGTH) {
			setStartError(
				"With the bots it's sent to named, this message is too long. Shorten it a little.",
			);
			return;
		}
		const files = attachments.takeForSending(draft);
		if (!files) return;
		const submitted = draft;
		const answered = replyingTo;
		setDraft("");
		setReplyingTo(undefined);
		try {
			const sent = send.mutateAsync({
				id: uuidv4(),
				message: addressedMessage,
				replyTo: answered,
				files: files.parts,
			});
			scrollToLatest();
			await sent;
			scrollToLatest();
		} catch (failure) {
			setDraft((current) => (current === "" ? submitted : current));
			setReplyingTo((current) => current ?? answered);
			files.putBack(failure);
		}
	}

	return {
		submit,
		pending: send.isPending,
		error: startError ?? (send.isError ? sendFailureMessage(send.error) : undefined),
	};
}

/** `message` with the bots it goes to but does not name named at its start. */
function withUnnamedBots(
	message: string,
	{ named, answering }: { named: readonly BotParticipant[]; answering: readonly BotParticipant[] },
): string {
	const unnamed = answering.filter((bot) => !named.includes(bot));
	return unnamed.length > 0
		? `${unnamed.map((bot) => `@${bot.handle}`).join(" ")} ${message}`
		: message;
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
