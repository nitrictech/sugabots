import type {
	Bot,
	BotParticipant,
	ConversationDetails,
	MessageReplyTo,
	SessionUser,
} from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { type Dispatch, type SetStateAction, useMemo } from "react";
import { useBot, useModelName } from "@/lib/bots.ts";
import type { ComposerAttachments } from "@/lib/composer-attachments.ts";
import { botSettingsLink } from "@/lib/links.ts";
import { listNames } from "@/lib/name-list.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { buttonStyles } from "@/ui/button.tsx";
import { ChatComposer } from "./ChatComposer.tsx";
import { ConnectionsNotice } from "./ConnectionsNotice.tsx";
import type { ChatRecipients, DraftAudience } from "./chat-recipients.ts";
import { groupMentionsBy, mentionableIn } from "./mentions.tsx";
import type { MessageSending } from "./message-sending.ts";
import { anyoneTyping, type Typer, TypingIndicator } from "./TypingIndicator.tsx";

/** Shown when marking a thread done, or reopening it, did not save. */
const DONE_FAILURE_MESSAGE = "This thread was not marked done or reopened. Try again.";
/** Every bot a message goes to is named, however many: "Ada, Bea and Cy". */
const EVERY_NAME = { maxNamed: Number.POSITIVE_INFINITY };

/**
 * The foot of a chat: the composer, saying whom the message goes to, and
 * under it who is typing, or else which bots will reply. While the chat's bot
 * has no model, a note on choosing one stands in for the composer.
 */
export function ConversationComposer({
	bot,
	host,
	details,
	user,
	namedBotsReply,
	chatName,
	draft,
	onDraftChange,
	replyingTo,
	onReplyingToChange,
	attachments,
	audience,
	recipients,
	sending,
	doneFailed,
	typers,
}: {
	/** The bot whose thread it is; null in a project's thread or a direct message. */
	bot: Bot | null;
	/** The bot whose thread it is, as the conversation lists it. */
	host: BotParticipant | undefined;
	details: ConversationDetails;
	user: SessionUser;
	/** Whether the bots people name reply here, as in a project. */
	namedBotsReply: boolean;
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
	/** Whether marking the thread done, or reopening it, last failed. */
	doneFailed: boolean;
	typers: readonly Typer[];
}) {
	// The model of the bot a message here goes to: the one named in the project, else this thread's own.
	const firstAnswering = useBot(recipients.answering[0]?.id);
	const answeringModel = useModelName(
		(namedBotsReply ? firstAnswering?.model : bot?.model) ?? null,
	);
	// Everyone here and the project's bots, not yourself. Naming a bot has it reply where
	// people talk among themselves, and asks this chat's own bot to bring it in elsewhere.
	const mentionable = useMemo(
		() => [
			...mentionableIn(details).filter((candidate) => candidate.id !== user.id),
			...groupMentionsBy(
				{ kind: "person", id: user.id },
				details.members,
				details.conversation.kind,
			),
		],
		[details, user.id],
	);
	const hint = replyHint({ namedBotsReply, answering: recipients.answering, audience, host });
	return (
		<div className="mx-auto w-full max-w-200 shrink-0 px-4 max-md:pb-tab-bar md:px-5">
			{bot?.model === null ? (
				<BotNotSetUp bot={bot} />
			) : (
				<ChatComposer
					label={composerLabel({ audience, automation: !!details.automation, bot, chatName })}
					pill
					model={audience.botStaysOut ? undefined : (answeringModel ?? undefined)}
					value={draft}
					onValueChange={onDraftChange}
					onSubmit={sending.submit}
					submitLabel="Send message"
					sending={sending.pending}
					error={sending.error ?? (doneFailed ? DONE_FAILURE_MESSAGE : undefined)}
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
					notice={bot && <ConnectionsNotice bot={bot} />}
				/>
			)}
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
	bot,
	chatName,
}: {
	audience: DraftAudience;
	/** Whether the chat is an automation's feed. */
	automation: boolean;
	bot: Bot | null;
	chatName: string;
}): string {
	if (audience.botStaysOut && audience.mentions.length > 0) {
		return `Message ${listNames(audience.mentions.map((person) => person.name))}`;
	}
	if (automation && bot) return `Message ${bot.name} about this automation`;
	return `Message ${chatName}`;
}

/**
 * Under the composer while nobody is typing: which bots will reply. In a
 * project, those the message goes to; in a bot's thread, whether its bot stays out,
 * or which bots it will ask for help.
 */
function replyHint({
	namedBotsReply,
	answering,
	audience,
	host,
}: {
	namedBotsReply: boolean;
	answering: readonly BotParticipant[];
	audience: DraftAudience;
	host: BotParticipant | undefined;
}): string | undefined {
	if (namedBotsReply) {
		return answering.length > 0
			? `${listNames(
					answering.map((bot) => bot.name),
					EVERY_NAME,
				)} will reply here.`
			: "Mention a bot to have it reply here.";
	}
	if (!host) return undefined;
	if (audience.botStaysOut) return `${host.name} won't reply.`;
	if (audience.askedForHelp.length > 0) {
		return `${host.name} will ask ${listNames(
			audience.askedForHelp.map((bot) => bot.name),
			EVERY_NAME,
		)} for help.`;
	}
	return undefined;
}

/**
 * Stands in for the composer while the bot has no model. The API refuses the
 * message anyway, so offering a box to type into would only lose the draft.
 * Only somebody who may edit the bot is offered the way to fix it.
 */
function BotNotSetUp({ bot }: { bot: Bot }) {
	const backToThread = useBackToHere("Thread");
	return (
		<p className="mx-auto m-0 w-full max-w-190 rounded-2xl border border-border-strong px-4 py-3.5 text-sm text-muted-foreground leading-relaxed">
			{bot.name} has no model yet, so it cannot answer.{" "}
			{bot.permissions.update ? (
				<>
					<Link
						{...botSettingsLink(bot)}
						state={backToThread}
						className={buttonStyles({ variant: "link", size: "bare" })}
					>
						Choose a model
					</Link>{" "}
					to start chatting.
				</>
			) : (
				"Somebody who can change this bot chooses its model."
			)}
		</p>
	);
}
