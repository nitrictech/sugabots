import type { ChatDetails, PersonParticipant } from "@sugabots/contracts";
import type { ChatLocation } from "@/lib/chats.ts";
import { OwnerPageCrumb, ProjectCrumb } from "@/shell/BotCrumb.tsx";
import {
	AutomationFace,
	type BackTo,
	backToOwner,
	ChatHeader,
	type ChatPlace,
	type HeaderPlace,
	PlainChatHeader,
	type ResolvedToggle,
} from "./ChatHeader.tsx";
import { ProjectChatMenu, type ProjectChatToChange } from "./ProjectChatMenu.tsx";

/**
 * The bar across the top of a chat, as its kind has it: an automation's
 * feed's, under its project's or bot's automations; a project's chat's, under
 * its project, with its menu; or a bot's chat's, with its bot and who is in it. All
 * but the feed's sit over the chat while `overChat`.
 */
export function ChatKindHeader({
	chatLocation,
	details,
	chatId,
	place,
	detailsAvailable,
	projectChatName,
	projectChatToChange,
	resolved,
	overChat,
	onOpenDesktop,
}: {
	chatLocation: ChatLocation;
	/** The chat once loaded. */
	details: ChatDetails | undefined;
	chatId: string;
	place: ChatPlace;
	/** Whether Details may open beside the chat: not while something is open large there. */
	detailsAvailable: boolean;
	/** What a project's chat is called, as its project lists it. */
	projectChatName: string;
	/** Renaming a project's chat, for whoever may change the project. */
	projectChatToChange: ProjectChatToChange | undefined;
	/** Whether a project's chat is resolved, and how to change that; absent for any other chat. */
	resolved: ResolvedToggle | undefined;
	/** Over the chat, which scrolls up under it, rather than a bar above it. */
	overChat: boolean;
	onOpenDesktop: () => void;
}) {
	const headerPlace = headerPlaceOf(place, {
		back: backToOwner(chatLocation),
		detailsAvailable,
	});
	if (details?.automation) {
		return (
			<PlainChatHeader
				{...headerPlace}
				title={details.chat.title}
				face={<AutomationFace />}
				crumbs={<OwnerPageCrumb owner={chatLocation} page="automations" />}
			/>
		);
	}
	if ("project" in chatLocation) {
		const { project } = chatLocation;
		return (
			<PlainChatHeader
				{...headerPlace}
				overChat={overChat}
				cards
				title={projectChatName}
				crumbs={<ProjectCrumb project={project} />}
				within={project.name}
				resolved={resolved}
				menu={projectChatToChange && <ProjectChatMenu {...projectChatToChange} />}
			/>
		);
	}
	return (
		<ChatHeader
			{...headerPlace}
			bot={chatLocation.bot}
			overChat={overChat}
			title={details?.chat.title}
			resolved={resolved}
			people={details?.participants.filter(
				(participant): participant is PersonParticipant => participant.kind === "person",
			)}
			chatId={chatId}
			onOpenDesktop={onOpenDesktop}
		/>
	);
}

/**
 * What the header does around its title on the chat's own page: Back to
 * where it lives, and its Details.
 */
function headerPlaceOf(
	place: ChatPlace,
	{ back, detailsAvailable }: { back: BackTo; detailsAvailable: boolean },
): HeaderPlace {
	return {
		back,
		trailing: place.trailing,
		parent: place.parent,
		details: detailsAvailable
			? { open: place.detailsOpen, onChange: place.onDetailsChange }
			: undefined,
	};
}
