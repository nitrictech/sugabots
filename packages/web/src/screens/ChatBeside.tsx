import type {
	ChatHistoryEntry,
	ConversationDetails,
	FilePart,
	Message,
	SessionUser,
} from "@sugabots/contracts";
import { useLocation } from "@tanstack/react-router";
import { type ConversationPlace, placeBot } from "@/lib/chats.ts";
import { conversationFileUrl } from "@/lib/conversation-files.ts";
import { resourcePermissions, useLeadBot } from "@/lib/resource-owner.tsx";
import { useLeave } from "@/ui/back-button.tsx";
import { AutomationPanel } from "./AutomationPanel.tsx";
import { AutomationsStage, type AutomationsView } from "./AutomationsStage.tsx";
import type { ChatPlace } from "./ChatHeader.tsx";
import { DesktopStage } from "./DesktopViewer.tsx";
import { type ConversationContents, DetailsSidebar, ProjectDetails } from "./DetailsSidebar.tsx";
import { FileStage } from "./Files.tsx";
import { ItemPanel } from "./ItemPanel.tsx";
import { opensBeside } from "./item-opening.ts";
import type { ProjectThreadToChange } from "./ProjectThreadMenu.tsx";
import type { Staged, StagedChange } from "./staged.ts";

/**
 * What is open beside a chat, one at a time: what is staged large, else the
 * collaboration open, else, on the chat's own page, its Details while they
 * are open.
 */
export function ChatBeside({
	conversationPlace: owner,
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
	projectThreadName,
	projectThreadToChange,
}: {
	conversationPlace: ConversationPlace;
	details: ConversationDetails;
	conversationId: string;
	user: SessionUser;
	place: ChatPlace;
	staged: Staged | undefined;
	onStagedChange: StagedChange;
	/** The collaboration or automation's run the chat's address names, if any. */
	itemConversationId: string | undefined;
	/** The collaborations and automations' runs the chat has opened. */
	entries: ChatHistoryEntry[];
	onItemChange: (itemConversationId: string | undefined) => void;
	onOpenItem: (itemConversationId: string) => void;
	onOpenFile: (fileId: string) => void;
	onOpenAutomations: (view?: AutomationsView) => void;
	/** The messages loaded so far, whose files Details lists. */
	shownMessages: readonly Message[];
	/** What a project's thread is called, as its project lists it. */
	projectThreadName: string;
	/** Renaming and archiving a project's thread, for whoever may change the project. */
	projectThreadToChange: ProjectThreadToChange | undefined;
}) {
	const { leaveFor } = useLeave();
	const { pathname } = useLocation();
	const bot = placeBot(owner);
	const lead = useLeadBot(owner);
	const closeStage = () => onStagedChange(undefined);

	if (staged?.kind === "file") {
		return (
			<FileStage
				owner={owner}
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
	if (staged?.kind === "desktop" && lead) {
		return (
			<DesktopStage
				conversationId={details.conversation.id}
				owner={owner}
				bot={lead}
				mayUse={resourcePermissions(owner).useDesktop}
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
	if (itemConversationId && opensBeside(itemConversationId, entries)) {
		return (
			<ItemPanel
				conversationId={conversationId}
				chatBotId={bot?.id}
				itemConversationId={itemConversationId}
				entry={entries.find((entry) => entry.conversationId === itemConversationId)}
				history={entries}
				frame={{ kind: "sidebar", onClose: () => onItemChange(undefined) }}
				onOpenItem={onOpenItem}
				onOpenFile={onOpenFile}
			/>
		);
	}
	if (place.kind !== "own" || !place.detailsOpen) return null;
	const closeDetails = () => place.onDetailsChange(false);
	const contents: ConversationContents = {
		participants: details.participants,
		files: shownMessages.flatMap((message) =>
			message.parts.filter((part): part is FilePart => part.type === "file"),
		),
		fileUrlOf: (fileId) => conversationFileUrl(conversationId, fileId),
	};
	// A project's automation's feed is set up beside it, as a bot's is.
	if (details.automation) {
		return (
			<AutomationPanel
				owner={owner}
				conversationId={conversationId}
				standing={details.automation}
				onClose={closeDetails}
			/>
		);
	}
	if ("project" in owner) {
		return (
			<ProjectDetails
				project={owner.project}
				name={projectThreadName}
				people={details.peopleReachingProject.length}
				bots={details.projectBots.length}
				toChange={projectThreadToChange}
				user={user}
				contents={contents}
				computer={
					lead && {
						bot: lead,
						conversationId: details.conversation.id,
						onOpen: () => onStagedChange({ kind: "desktop" }),
					}
				}
				onClose={closeDetails}
			/>
		);
	}
	return (
		<DetailsSidebar
			bot={owner.bot}
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
