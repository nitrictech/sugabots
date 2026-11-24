import type { ChatDetails, CurrentUser, MessageReplyTo } from "@sugabots/contracts";
import { type Dispatch, type SetStateAction, useMemo } from "react";
import type { ChatLocation } from "@/lib/chats.ts";
import type { ComposerAttachments } from "@/lib/composer-attachments.ts";
import { listNames } from "@/lib/name-list.ts";
import { BotsWithoutModelNotice, useRequiredRepliers } from "./BotsWithoutModelNotice.tsx";
import { ChatComposer } from "./ChatComposer.tsx";
import { ConnectorsNotice } from "./ConnectorsNotice.tsx";
import type { ChatRecipients, DraftAudience } from "./chat-recipients.ts";
import { composerMentionable } from "./mentions.tsx";
import type { MessageSending } from "./message-sending.ts";
import { anyoneTyping, type Typer, TypingIndicator } from "./TypingIndicator.tsx";

/** Shown when marking a chat resolved, or reopening it, did not save. */
const RESOLVE_FAILURE_MESSAGE = "This chat was not marked resolved or reopened. Try again.";
/** Every bot a message goes to is named, however many: "Ada, Bea and Cy". */
const EVERY_NAME = { maxNamed: Number.POSITIVE_INFINITY };

/**
 * The foot of a chat: the composer, saying whom the message goes to, and
 * under it who is typing, or else which bots will reply when that is not
 * simply the lead. While a bot that
 * must reply to the draft has no model, the server would refuse it, so the
 * composer says so in place of the reply hint and holds Send.
 */
export function ChatFooter({
	chatLocation,
	details,
	signedIn,
	chatName,
	draft,
	onDraftChange,
	replyingTo,
	onReplyingToChange,
	attachments,
	audience,
	recipients,
	sending,
	resolveFailed,
	typers,
}: {
	/** Where the chat is: one of a project's chats, or one of a bot's. */
	chatLocation: ChatLocation;
	details: ChatDetails;
	signedIn: CurrentUser;
	/** Whom the composer says a message goes to while the draft names nobody. */
	chatName: string;
	draft: string;
	onDraftChange: Dispatch<SetStateAction<string>>;
	replyingTo: MessageReplyTo | undefined;
	onReplyingToChange: (replyingTo: MessageReplyTo | undefined) => void;
	attachments: ComposerAttachments;
	audience: DraftAudience;
	recipients: ChatRecipients;
	sending: MessageSending;
	/** Whether marking the chat resolved, or reopening it, last failed. */
	resolveFailed: boolean;
	typers: readonly Typer[];
}) {
	const { withoutModel, modelName } = useRequiredRepliers(audience.floor);
	const mentionable = useMemo(
		() => composerMentionable(details, signedIn, details.chat.kind),
		[details, signedIn],
	);
	const held = withoutModel.length > 0;
	const hint = held ? undefined : replyHint(audience);
	return (
		<div className="mx-auto w-full max-w-200 shrink-0 px-4 max-md:pb-tab-bar md:px-5">
			<ChatComposer
				label={composerLabel({ audience, automation: !!details.automation, chatName })}
				model={modelName}
				value={draft}
				onValueChange={onDraftChange}
				onSubmit={sending.submit}
				submitLabel="Send message"
				sending={sending.pending}
				held={held}
				error={sending.error ?? (resolveFailed ? RESOLVE_FAILURE_MESSAGE : undefined)}
				mentionable={mentionable}
				replyingTo={
					replyingTo && { message: replyingTo, onCancel: () => onReplyingToChange(undefined) }
				}
				addressed={{
					// Those the draft names too, so the row shows everyone the message goes to.
					bots: [...recipients.addressed, ...recipients.named],
					onRemove: recipients.remove,
					onClearInherited: recipients.clearAddressed,
				}}
				attachments={attachments}
				notice={
					<>
						{held && <BotsWithoutModelNotice bots={withoutModel} />}
						<ConnectorsNotice owner={chatLocation} />
					</>
				}
			/>
			{/*
			 * Always its height, so nothing moves as somebody starts or stops typing.
			 * On a phone, with the tabs straight under it, it takes room only while
			 * there is something to say, and is a small gap above the tabs otherwise.
			 */}
			<div className="flex h-6.5 items-center max-md:h-auto max-md:min-h-2 max-md:[&>*]:py-1">
				{anyoneTyping(typers) ? (
					<TypingIndicator typers={typers} className="px-1" />
				) : (
					hint && <p className="m-0 px-1 text-xs text-muted-foreground">{hint}</p>
				)}
			</div>
		</div>
	);
}

/** What the composer is labelled: whom the message goes to. */
function composerLabel({
	audience,
	automation,
	chatName,
}: {
	audience: DraftAudience;
	/** Whether the chat is an automation's feed. */
	automation: boolean;
	chatName: string;
}): string {
	if (audience.membersOnly && audience.mentions.length > 0) {
		return `Message ${listNames(audience.mentions.map((member) => member.name))}`;
	}
	const { floor } = audience;
	if (automation && floor.kind === "lead")
		return `Message ${floor.lead.name} about this automation`;
	return `Message ${chatName}`;
}

/**
 * Under the composer while nobody is typing: who answers the message, by the
 * floor's rule. Nothing while the lead answers a draft that mentions nobody,
 * as it answers every such message.
 */
function replyHint({ floor, mentions }: DraftAudience): string | undefined {
	switch (floor.kind) {
		case "bots":
			return `${listNames(
				floor.bots.map((bot) => bot.name),
				EVERY_NAME,
			)} will reply here.`;
		case "lead":
			return mentions.length > 0 ? `${floor.lead.name} will reply here.` : undefined;
		case "leadMayReply":
			return `${floor.lead.name} may reply.`;
		case "leadWontReply":
			return `${floor.lead.name} won't reply.`;
		case "nobody":
			return undefined;
	}
}
