import { botParticipantOf } from "@sugabots/contracts";
import { useRouter } from "@tanstack/react-router";
import { cn } from "cn";
import { useState } from "react";
import { CHAT_NOT_STARTED, needsViewer, useChatStarter, useProjectChats } from "@/lib/chats.ts";
import { usePeopleReachingProject, useProjectBots } from "@/lib/projects.ts";
import {
	ownerName,
	type ResourceOwner,
	resourceProjectId,
	useLeadBot,
	useNavigateToOwnerPage,
} from "@/lib/resource-owner.tsx";
import { useSession } from "@/lib/session.ts";
import { useSidebarHiddenBesideChat } from "@/lib/sidebar-hidden.tsx";
import { WatchingAvatar } from "@/shell/Bot.tsx";
import { OwnerCrumb } from "@/shell/BotCrumb.tsx";
import { BotsWithoutModelNotice, useRequiredRepliers } from "./BotsWithoutModelNotice.tsx";
import { ChatComposer } from "./ChatComposer.tsx";
import { backToOwner, PlainChatHeader } from "./ChatHeader.tsx";
import { draftAudience } from "./chat-recipients.ts";
import { composerMentionable } from "./mentions.tsx";

/**
 * Where a chat starts from its first message: a bot's or a project's new
 * chat, and a bot's own page on a wider screen. Its bot's face (a project's lead bot's), what of the
 * work there waits on the viewer, and the box to give it something new.
 * Sending starts the chat and opens it. Files are added once it has started.
 * The box waits for the bot, which the roster may not have yet.
 */
export function NewChatPage({ owner }: { owner: ResourceOwner }) {
	const chats = useChatStarter({ projectId: resourceProjectId(owner) });
	const navigateToOwnerPage = useNavigateToOwnerPage();
	const router = useRouter();
	const [draft, setDraft] = useState("");
	const [failed, setFailed] = useState(false);
	// The bot the page shows: the bot itself, or the project's lead bot.
	const bot = useLeadBot(owner);
	const name = ownerName(owner);
	const waiting = useWaitingOnViewer(owner);
	const viewer = useSession().person;
	const lead = bot && botParticipantOf(bot);
	// A bot's default project has only the bot, its lead; a project's bots are asked for.
	const projectBots =
		useProjectBots("project" in owner ? owner.project.id : undefined).data?.map(botParticipantOf) ??
		(lead ? [lead] : []);
	// Whom a mention can name, as in any of the project's chats: nobody is in this one yet.
	const people = usePeopleReachingProject(resourceProjectId(owner)).data ?? [];
	const mentionable = viewer
		? composerMentionable(
				{ participants: [], projectBots, peopleReachingProject: [...people] },
				viewer,
				"project_chat",
			)
		: [];
	// The first message is a chat's like any other, so the floor's rule says who must reply to it.
	const { withoutModel, modelName } = useRequiredRepliers(
		draftAudience({
			draft,
			chatKind: "project_chat",
			// Yourself too: a message that mentions only you mentions only people.
			mentionable: [...projectBots, ...people],
			projectBots,
			lead,
			leadHasModel: bot?.model != null,
			chosen: [],
			replyingTo: undefined,
		}).floor,
	);
	// The page names itself in its middle; the header is kept on a phone for its Back.
	const header = (
		<div className="md:hidden">
			<PlainChatHeader title="New chat" back={backToOwner(owner)} />
		</div>
	);
	async function submit() {
		setFailed(false);
		const sentFrom = historyEntryKey(router);
		const started = await chats.start(draft);
		if (started.outcome === "refused") setFailed(true);
		if (started.outcome !== "started") return;
		// Somebody who went elsewhere while it started stays there; the chat is in its list.
		if (historyEntryKey(router) !== sentFrom) return;
		await navigateToOwnerPage(owner, {
			page: "chat",
			chatId: started.chat.chat.id,
		});
	}

	return (
		<div className="flex min-w-0 flex-1 flex-col">
			{header}
			<OwnerPageBar owner={owner} />
			<div className="flex min-h-0 flex-1 flex-col items-center justify-end overflow-y-auto px-5 pb-16 md:justify-center md:pb-24">
				<div className="flex w-full max-w-180 flex-col items-center gap-6">
					<div className="flex flex-col items-center gap-3 text-center">
						{/* It watches the request being written, and thinks while the chat starts. */}
						{bot && <WatchingAvatar bot={bot} size={64} busy={chats.isPending} watching />}
						<h2 className="m-0 font-semibold text-2xl text-foreground tracking-tight">
							{greetingFor(waiting)}
						</h2>
					</div>
					{bot && (
						<ChatComposer
							label={`Message ${name}`}
							placeholder={`Ask ${bot.name} to…`}
							tall
							model={modelName}
							value={draft}
							onValueChange={setDraft}
							onSubmit={submit}
							submitLabel="Start chat"
							sending={chats.isPending}
							held={withoutModel.length > 0}
							notice={withoutModel.length > 0 && <BotsWithoutModelNotice bots={withoutModel} />}
							error={failed ? CHAT_NOT_STARTED : undefined}
							mentionable={mentionable}
						/>
					)}
				</div>
			</div>
		</div>
	);
}

/** The browser history entry open, which a page opened since, or reopened, has a key of its own for. */
function historyEntryKey(router: ReturnType<typeof useRouter>): string | undefined {
	return router.history.location.state.__TSR_key;
}

/** How many of the bot's or project's open chats wait on the viewer, which its page greets them with. */
function useWaitingOnViewer(owner: ResourceOwner): number {
	const chats = useProjectChats(resourceProjectId(owner)).data?.chats;
	return (chats ?? []).filter(needsViewer).length;
}

/**
 * From a tablet up, the top of the page: its breadcrumb, the bot or project
 * alone, clear of the sidebar's button while the sidebar is away.
 */
function OwnerPageBar({ owner }: { owner: ResourceOwner }) {
	const sidebarHidden = useSidebarHiddenBesideChat();
	return (
		<div
			className={cn(
				"hidden h-13 shrink-0 items-center pr-4 transition-all duration-300 ease-out md:flex",
				sidebarHidden ? "pl-14" : "pl-6",
			)}
		>
			<OwnerCrumb owner={owner} />
		</div>
	);
}

/** How a bot's page greets the viewer: with what waits on them, else ready for more. */
function greetingFor(waiting: number): string {
	if (waiting === 1) return "One thing needs you first";
	if (waiting > 1) return `${waiting} things need you first`;
	return "What do you need done?";
}
