import type {
	Channel,
	ConversationDetails,
	PersonParticipant,
	SessionUser,
} from "@sugabots/contracts";
import { type ConversationPlaceKind, directPeopleTitle, isOneToOne } from "@/lib/chats.ts";
import { AutomationsCrumb } from "@/shell/BotCrumb.tsx";
import { DirectPeopleAvatar } from "@/shell/DirectMessages.tsx";
import {
	type BackTo,
	ChatHeader,
	type ChatPlace,
	type DoneToggle,
	type HeaderPlace,
	PeopleChatHeader,
	PHONE_FACE_SIZE_PX,
} from "./ChatHeader.tsx";
import { type ChannelConversationToChange, ChatMenu } from "./ChatMenu.tsx";
import { DirectMembersButton } from "./DirectMembers.tsx";

/**
 * The bar across the top of a conversation, as its kind has it: a task's, with
 * its bot and who is in it; an automation's feed's, under its bot's automations;
 * a channel's main chat's or thread's, with its menu; or a direct message's,
 * with whom it is with.
 */
export function ConversationHeader({
	conversation,
	channel,
	details,
	conversationId,
	user,
	place,
	detailsAvailable,
	channelConversationName,
	channelConversationToChange,
	done,
	overChat,
	onOpenDesktop,
}: {
	conversation: ConversationPlaceKind;
	/** The channel it is in; null for a bot's task or a direct message. */
	channel: Channel | null;
	/** The conversation once loaded. */
	details: ConversationDetails | undefined;
	conversationId: string;
	user: SessionUser;
	place: ChatPlace;
	/** Whether Details may open beside the chat: not while something is open large there. */
	detailsAvailable: boolean;
	/** What a channel's conversation is called, as its channel lists it. */
	channelConversationName: string;
	/** Renaming and archiving a channel's conversation, for whoever may change the channel. */
	channelConversationToChange: ChannelConversationToChange | undefined;
	/** Whether a task is done, and how to change that; absent for any other conversation. */
	done: DoneToggle | undefined;
	/** Over a bot's task, which scrolls up under it, rather than a bar above it. */
	overChat: boolean;
	onOpenDesktop: () => void;
}) {
	const title = details?.conversation.title;
	const headerPlace = headerPlaceOf(place, {
		back: backOf(conversation, channel),
		detailsAvailable,
	});
	if (conversation.kind === "botConversation" && details?.automation) {
		return (
			<PeopleChatHeader
				{...headerPlace}
				title={details.conversation.title}
				mark="automation"
				crumbs={<AutomationsCrumb bot={conversation.bot} />}
			/>
		);
	}
	if (conversation.kind === "botConversation") {
		return (
			<ChatHeader
				{...headerPlace}
				bot={conversation.bot}
				overChat={overChat}
				title={title}
				done={done}
				people={details?.participants.filter(
					(participant): participant is PersonParticipant => participant.kind === "person",
				)}
				conversationId={conversationId}
				onOpenDesktop={onOpenDesktop}
			/>
		);
	}
	if (conversation.kind === "channelConversation") {
		return (
			<PeopleChatHeader
				{...headerPlace}
				title={channelConversationName}
				menu={channelConversationToChange && <ChatMenu {...channelConversationToChange} />}
			/>
		);
	}
	return (
		<PeopleChatHeader
			{...headerPlace}
			// Nothing opens beside a direct message: who is in a group drops down from its members' count.
			details={undefined}
			title={directPeopleTitle(conversation)}
			face={<DirectPeopleAvatar {...conversation} size={PHONE_FACE_SIZE_PX} />}
			detail={
				isOneToOne(conversation) ? undefined : (
					<DirectMembersButton direct={conversation} user={user} />
				)
			}
		/>
	);
}

/** Where Back returns to from a conversation: its bot, its channel, or the direct messages. */
function backOf(conversation: ConversationPlaceKind, channel: Channel | null): BackTo {
	if (conversation.kind === "botConversation") return { to: "bot", bot: conversation.bot };
	if (channel) return { to: "channel", channel };
	return { to: "directMessages" };
}

/**
 * What the header does around its title where the chat is shown: on its own
 * page, Back to where it lives and its Details; elsewhere, Back to where it
 * was opened from.
 */
function headerPlaceOf(
	place: ChatPlace,
	{ back, detailsAvailable }: { back: BackTo; detailsAvailable: boolean },
): HeaderPlace {
	if (place.kind === "away") return { back: place.back, trailing: place.trailing };
	return {
		back,
		trailing: place.trailing,
		parent: place.parent,
		details: detailsAvailable
			? { open: place.detailsOpen, onChange: place.onDetailsChange }
			: undefined,
	};
}
