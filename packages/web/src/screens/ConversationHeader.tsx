import type { ConversationDetails, PersonParticipant, SessionUser } from "@sugabots/contracts";
import { directPeopleTitle, isOneToOne } from "@/lib/chats.ts";
import { OwnerPageCrumb, ProjectCrumb } from "@/shell/BotCrumb.tsx";
import { DirectPeopleAvatar } from "@/shell/DirectMessages.tsx";
import {
	AutomationFace,
	type BackTo,
	ChatHeader,
	type ChatPlace,
	type DoneToggle,
	type HeaderPlace,
	PHONE_FACE_SIZE_PX,
	PlainChatHeader,
} from "./ChatHeader.tsx";
import type { AnyConversationPlace } from "./conversation-place.ts";
import { DirectMembersButton } from "./DirectMembers.tsx";
import { ProjectThreadMenu, type ProjectThreadToChange } from "./ProjectThreadMenu.tsx";

/**
 * The bar across the top of a conversation, as its kind has it: a bot's thread's,
 * with its bot and who is in it; an automation's feed's, under its bot's
 * automations; a project's thread's, under its project, with its menu; or a
 * direct message's, with whom it is with. All but the feed's sit over the chat
 * while `overChat`.
 */
export function ConversationHeader({
	conversationPlace,
	details,
	conversationId,
	user,
	place,
	detailsAvailable,
	projectThreadName,
	projectThreadToChange,
	done,
	overChat,
	onOpenDesktop,
}: {
	conversationPlace: AnyConversationPlace;
	/** The conversation once loaded. */
	details: ConversationDetails | undefined;
	conversationId: string;
	user: SessionUser;
	place: ChatPlace;
	/** Whether Details may open beside the chat: not while something is open large there. */
	detailsAvailable: boolean;
	/** What a project's thread is called, as its project lists it. */
	projectThreadName: string;
	/** Renaming and archiving a project's thread, for whoever may change the project. */
	projectThreadToChange: ProjectThreadToChange | undefined;
	/** Whether a thread is done, and how to change that; absent for any other conversation. */
	done: DoneToggle | undefined;
	/** Over the chat, which scrolls up under it, rather than a bar above it. */
	overChat: boolean;
	onOpenDesktop: () => void;
}) {
	const headerPlace = headerPlaceOf(place, {
		back: backOf(conversationPlace),
		detailsAvailable,
	});
	if (conversationPlace.project) {
		const { project } = conversationPlace;
		return (
			<PlainChatHeader
				{...headerPlace}
				overChat={overChat}
				cards
				title={projectThreadName}
				crumbs={<ProjectCrumb project={project} />}
				within={project.name}
				done={done}
				menu={projectThreadToChange && <ProjectThreadMenu {...projectThreadToChange} />}
			/>
		);
	}
	const { conversation } = conversationPlace;
	if (conversation.kind === "directMessage") {
		return (
			<PlainChatHeader
				{...headerPlace}
				overChat={overChat}
				// Nothing opens beside a direct message: who is in a group drops down from its people's count.
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
	if (details?.automation) {
		return (
			<PlainChatHeader
				{...headerPlace}
				title={details.conversation.title}
				face={<AutomationFace />}
				crumbs={<OwnerPageCrumb owner={{ bot: conversation.bot }} page="automations" />}
			/>
		);
	}
	return (
		<ChatHeader
			{...headerPlace}
			bot={conversation.bot}
			overChat={overChat}
			title={details?.conversation.title}
			done={done}
			people={details?.participants.filter(
				(participant): participant is PersonParticipant => participant.kind === "person",
			)}
			conversationId={conversationId}
			onOpenDesktop={onOpenDesktop}
		/>
	);
}

/** Where Back returns to from a conversation: its project, its bot, or the direct messages. */
function backOf(conversationPlace: AnyConversationPlace): BackTo {
	if (conversationPlace.project) return { to: "project", project: conversationPlace.project };
	const { conversation } = conversationPlace;
	if (conversation.kind === "botThread") return { to: "bot", bot: conversation.bot };
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
