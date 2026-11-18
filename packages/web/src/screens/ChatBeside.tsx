import type {
	Bot,
	Channel,
	ChatHistoryEntry,
	ConversationDetails,
	FilePart,
	Message,
	SessionUser,
} from "@sugabots/contracts";
import { useLocation } from "@tanstack/react-router";
import { chatFileUrl } from "@/lib/chat-files.ts";
import type { ConversationPlaceKind } from "@/lib/chats.ts";
import { useLeave } from "@/ui/back-button.tsx";
import { AutomationPanel } from "./AutomationPanel.tsx";
import { AutomationsStage, type AutomationsView } from "./AutomationsStage.tsx";
import type { ChatPlace } from "./ChatHeader.tsx";
import type { ChannelConversationToChange } from "./ChatMenu.tsx";
import { DesktopStage } from "./DesktopViewer.tsx";
import {
	ChannelDetails,
	type ConversationContents,
	DetailsSidebar,
	PeopleDetails,
} from "./DetailsSidebar.tsx";
import { FileStage } from "./Files.tsx";
import { ItemPanel } from "./ItemPanel.tsx";
import type { Staged, StagedChange } from "./staged.ts";
import { TasksStage } from "./TasksStage.tsx";

/**
 * What is open beside a chat, one at a time: what is staged large, else the
 * collaboration or automation run open, else, on the chat's own page, its
 * Details while they are open. Nothing opens beside a direct message but a
 * file.
 */
export function ChatBeside({
	conversation,
	channel,
	bot,
	details,
	conversationId,
	user,
	place,
	staged,
	onStagedChange,
	itemConversationId,
	entries,
	onItemChange,
	onOpenItem,
	onOpenFile,
	onOpenAutomations,
	shownMessages,
	channelConversationName,
	channelConversationToChange,
}: {
	conversation: ConversationPlaceKind;
	channel: Channel | null;
	/** The chat's own bot; null in a channel or a direct message. */
	bot: Bot | null;
	details: ConversationDetails;
	conversationId: string;
	user: SessionUser;
	place: ChatPlace;
	staged: Staged | undefined;
	onStagedChange: StagedChange;
	/** The collaboration or automation run open beside the chat, if any. */
	itemConversationId: string | undefined;
	/** The collaborations and automation runs the chat has opened. */
	entries: ChatHistoryEntry[];
	onItemChange: (itemConversationId: string | undefined) => void;
	onOpenItem: (itemConversationId: string) => void;
	onOpenFile: (fileId: string) => void;
	onOpenAutomations: (view?: AutomationsView) => void;
	/** The messages loaded so far, whose files Details lists. */
	shownMessages: readonly Message[];
	/** What a channel's conversation is called, as its channel lists it. */
	channelConversationName: string;
	/** Renaming and archiving a channel's conversation, for whoever may change the channel. */
	channelConversationToChange: ChannelConversationToChange | undefined;
}) {
	const { leaveFor } = useLeave();
	const { pathname } = useLocation();
	const selectedEntry = itemConversationId
		? entries.find((entry) => entry.conversationId === itemConversationId)
		: undefined;
	const closeStage = () => onStagedChange(undefined);

	if (staged?.kind === "file" && (channel || bot)) {
		return (
			<FileStage
				owner={channel ? { channel } : { bot: bot as Bot }}
				fileId={staged.fileId}
				version={staged.version}
				onVersionChange={(version) => onStagedChange({ ...staged, version })}
				// Leaving in its place, as a deleted one is left, goes back to the chat when that is behind.
				onClose={(how) =>
					how?.replace
						? leaveFor(
								(page) => page.pathname === pathname && page.search.file === undefined,
								() => onStagedChange(undefined, how),
							)
						: onStagedChange(undefined)
				}
			/>
		);
	}
	if (staged?.kind === "desktop" && bot) {
		return (
			<DesktopStage
				conversationId={details.conversation.id}
				bot={bot}
				mayUse={bot.permissions.useDesktop}
				onClose={closeStage}
			/>
		);
	}
	if (staged?.kind === "tasks" && bot) {
		return (
			<TasksStage
				bot={bot}
				tab={staged.tab}
				onTabChange={(tab) => onStagedChange({ kind: "tasks", tab }, { replace: true })}
				onClose={closeStage}
			/>
		);
	}
	if (staged?.kind === "automations" && bot) {
		return (
			<AutomationsStage
				bot={bot}
				user={user}
				view={staged.view}
				onViewChange={onOpenAutomations}
				onStagedChange={onStagedChange}
				onClose={closeStage}
			/>
		);
	}
	if (
		itemConversationId &&
		conversation.kind !== "directMessage" &&
		selectedEntry?.kind !== "run"
	) {
		return (
			<ItemPanel
				conversationId={conversationId}
				chatBotId={bot?.id}
				itemConversationId={itemConversationId}
				entry={selectedEntry}
				history={entries}
				frame={{ kind: "sidebar", onClose: () => onItemChange(undefined) }}
				onOpenItem={onOpenItem}
				onOpenFile={onOpenFile}
			/>
		);
	}
	if (place.kind !== "own" || !place.detailsOpen || conversation.kind === "directMessage") {
		return null;
	}
	const closeDetails = () => place.onDetailsChange(false);
	const contents: ConversationContents = {
		participants: details.participants,
		files: shownMessages.flatMap((message) =>
			message.parts.filter((part): part is FilePart => part.type === "file"),
		),
		fileUrlOf: (fileId) => chatFileUrl(conversationId, fileId),
	};
	if (conversation.kind === "channelConversation") {
		return (
			<ChannelDetails
				name={channelConversationName}
				people={details.members.length}
				bots={details.channelBots.filter((member) => member.kind === "bot").length}
				toChange={channelConversationToChange}
				user={user}
				contents={contents}
				onClose={closeDetails}
			/>
		);
	}
	if (details.automation && bot) {
		return (
			<AutomationPanel
				bot={bot}
				conversationId={conversationId}
				standing={details.automation}
				onClose={closeDetails}
			/>
		);
	}
	if (bot) {
		return (
			<DetailsSidebar
				bot={bot}
				conversationId={details.conversation.id}
				contents={contents}
				onOpenDesktop={() => onStagedChange({ kind: "desktop" })}
				onOpenAutomations={(automationId) =>
					onOpenAutomations(automationId ? { kind: "automation", automationId } : undefined)
				}
				onClose={closeDetails}
			/>
		);
	}
	return <PeopleDetails user={user} contents={contents} onClose={closeDetails} />;
}
