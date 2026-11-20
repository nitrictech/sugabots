import type { ConversationDetails, PersonParticipant } from "@sugabots/contracts";
import type { ConversationPlace } from "@/lib/chats.ts";
import { OwnerPageCrumb, ProjectCrumb } from "@/shell/BotCrumb.tsx";
import {
	AutomationFace,
	type BackTo,
	backToOwner,
	ChatHeader,
	type ChatPlace,
	type DoneToggle,
	type HeaderPlace,
	PlainChatHeader,
} from "./ChatHeader.tsx";
import { ProjectThreadMenu, type ProjectThreadToChange } from "./ProjectThreadMenu.tsx";

/**
 * The bar across the top of a conversation, as its kind has it: an automation's
 * feed's, under its project's or bot's automations; a project's thread's, under
 * its project, with its menu; or a bot's thread's, with its bot and who is in it. All
 * but the feed's sit over the chat while `overChat`.
 */
export function ConversationHeader({
	conversationPlace,
	details,
	conversationId,
	place,
	detailsAvailable,
	projectThreadName,
	projectThreadToChange,
	done,
	overChat,
	onOpenDesktop,
}: {
	conversationPlace: ConversationPlace;
	/** The conversation once loaded. */
	details: ConversationDetails | undefined;
	conversationId: string;
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
		back: backToOwner(conversationPlace),
		detailsAvailable,
	});
	if (details?.automation) {
		return (
			<PlainChatHeader
				{...headerPlace}
				title={details.conversation.title}
				face={<AutomationFace />}
				crumbs={<OwnerPageCrumb owner={conversationPlace} page="automations" />}
			/>
		);
	}
	if ("project" in conversationPlace) {
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
	return (
		<ChatHeader
			{...headerPlace}
			bot={conversationPlace.bot}
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
