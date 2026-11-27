import type { ChatDetails, CurrentUser, FilePart, Message } from "@sugabots/contracts";
import { useLocation } from "@tanstack/react-router";
import { chatFileUrl } from "@/lib/chat-files.ts";
import { type ChatLocation, placeBot } from "@/lib/chats.ts";
import { useLeadBot } from "@/lib/resource-owner.tsx";
import { useLeave } from "@/ui/back-button.tsx";
import { AutomationPanel } from "./AutomationPanel.tsx";
import { AutomationsStage, type AutomationsView } from "./AutomationsStage.tsx";
import type { ChatPlace } from "./ChatHeader.tsx";
import { DesktopStage } from "./DesktopViewer.tsx";
import { type ChatContents, DetailsPanel, ProjectDetails } from "./DetailsPanel.tsx";
import { FileStage } from "./Files.tsx";
import type { ProjectChatToChange } from "./ProjectChatMenu.tsx";
import type { Staged, StagedChange } from "./staged.ts";

/**
 * What is open beside a chat, one at a time: what is staged large, else, on
 * the chat's own page, its Details while they are open.
 */
export function ChatBeside({
	chatLocation: owner,
	details,
	chatId,
	signedIn,
	place,
	staged,
	onStagedChange,
	onOpenAutomations,
	shownMessages,
	projectChatName,
	projectChatToChange,
}: {
	chatLocation: ChatLocation;
	details: ChatDetails;
	chatId: string;
	signedIn: CurrentUser;
	place: ChatPlace;
	staged: Staged | undefined;
	onStagedChange: StagedChange;
	onOpenAutomations: (view?: AutomationsView) => void;
	/** The messages loaded so far, whose files Details lists. */
	shownMessages: readonly Message[];
	/** What a project's chat is called, as its project lists it. */
	projectChatName: string;
	/** Renaming a project's chat, for whoever may change the project. */
	projectChatToChange: ProjectChatToChange | undefined;
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
		return <DesktopStage chatId={details.chat.id} owner={owner} bot={lead} onClose={closeStage} />;
	}
	if (staged?.kind === "automations" && bot) {
		return (
			<AutomationsStage
				bot={bot}
				signedIn={signedIn}
				view={staged.view}
				onViewChange={onOpenAutomations}
				onStagedChange={onStagedChange}
				onClose={closeStage}
			/>
		);
	}
	if (place.kind !== "own" || !place.detailsOpen) return null;
	const closeDetails = () => place.onDetailsChange(false);
	const contents: ChatContents = {
		participants: details.participants,
		files: shownMessages.flatMap((message) =>
			message.parts.filter((part): part is FilePart => part.type === "file"),
		),
		fileUrlOf: (fileId) => chatFileUrl(chatId, fileId),
	};
	// A project's automation's feed is set up beside it, as a bot's is.
	if (details.automation) {
		return (
			<AutomationPanel
				owner={owner}
				chatId={chatId}
				standing={details.automation}
				onClose={closeDetails}
			/>
		);
	}
	if ("project" in owner) {
		return (
			<ProjectDetails
				project={owner.project}
				name={projectChatName}
				members={details.membersReachingProject.length}
				bots={details.projectBots.length}
				toChange={projectChatToChange}
				signedIn={signedIn}
				contents={contents}
				computer={
					lead && {
						bot: lead,
						chatId: details.chat.id,
						onOpen: () => onStagedChange({ kind: "desktop" }),
					}
				}
				onClose={closeDetails}
			/>
		);
	}
	return (
		<DetailsPanel
			bot={owner.bot}
			chatId={details.chat.id}
			contents={contents}
			onOpenDesktop={() => onStagedChange({ kind: "desktop" })}
			onOpenAutomations={(automationId) =>
				onOpenAutomations(automationId ? { kind: "automation", automationId } : undefined)
			}
			onClose={closeDetails}
		/>
	);
}
