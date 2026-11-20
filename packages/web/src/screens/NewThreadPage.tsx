import type { Bot, BotParticipant } from "@sugabots/contracts";
import { useRouter } from "@tanstack/react-router";
import { cn } from "cn";
import { useState } from "react";
import { THREAD_NOT_STARTED, useProjectThreads, useThreadStarter } from "@/lib/chats.ts";
import { useComposerAttachments } from "@/lib/composer-attachments.ts";
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
import { EmptyState } from "@/ui/empty-state.tsx";
import { BotsWithoutModelNotice, useRequiredRepliers } from "./BotsWithoutModelNotice.tsx";
import { ChatComposer } from "./ChatComposer.tsx";
import { backToOwner, PlainChatHeader } from "./ChatHeader.tsx";
import { draftAudience } from "./chat-recipients.ts";
import { composerMentionable } from "./mentions.tsx";

/**
 * Where a thread starts from its first message: a bot's or a project's new
 * thread, and a bot's own page on a wider screen. Its bot's face (a project's lead bot's), what of the
 * work there waits on the viewer, and the box to give it something new.
 * Sending starts the thread and opens it. Files are added once it has started.
 */
export function NewThreadPage({ owner }: { owner: ResourceOwner }) {
	// A thread has nowhere to upload to until it starts.
	const attachments = useComposerAttachments(undefined);
	const threads = useThreadStarter({ projectId: resourceProjectId(owner) });
	const navigateToOwnerPage = useNavigateToOwnerPage();
	const router = useRouter();
	const [draft, setDraft] = useState("");
	const [failed, setFailed] = useState(false);
	// The bot the page shows: the bot itself, or the project's lead bot.
	const bot = useLeadBot(owner);
	const name = ownerName(owner);
	const waiting = useWaitingOnViewer(owner);
	const viewer = useSession().user;
	const lead = bot && botParticipantOf(bot);
	// A bot's default project has only the bot, its lead; a project's bots are asked for.
	const projectBots =
		useProjectBots("project" in owner ? owner.project.id : undefined).data?.map(botParticipantOf) ??
		(lead ? [lead] : []);
	// Whom a mention can name, as in any of the project's threads: nobody is in this one yet.
	const people = usePeopleReachingProject(resourceProjectId(owner)).data ?? [];
	const mentionable = viewer
		? composerMentionable(
				{ participants: [], projectBots, peopleReachingProject: [...people] },
				viewer,
				"project_thread",
			)
		: [];
	// The first message is a thread's like any other, so the floor's rule says who must reply to it.
	const { withoutModel, modelName } = useRequiredRepliers(
		draftAudience({
			draft,
			conversationKind: "project_thread",
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
			<PlainChatHeader title="New thread" back={backToOwner(owner)} />
		</div>
	);
	async function submit() {
		setFailed(false);
		const sentFrom = historyEntryKey(router);
		const started = await threads.start(draft);
		if (started.outcome === "refused") setFailed(true);
		if (started.outcome !== "started") return;
		// Somebody who went elsewhere while it started stays there; the thread is in its list.
		if (historyEntryKey(router) !== sentFrom) return;
		await navigateToOwnerPage(owner, {
			page: "thread",
			conversationId: started.thread.conversation.id,
		});
	}

	return (
		<div className="flex min-w-0 flex-1 flex-col">
			{header}
			<OwnerPageBar owner={owner} />
			<div className="flex min-h-0 flex-1 flex-col items-center justify-end overflow-y-auto px-5 pb-16 md:justify-center md:pb-24">
				<div className="flex w-full max-w-180 flex-col items-center gap-6">
					<div className="flex flex-col items-center gap-3 text-center">
						{/* It watches the request being written, and thinks while the thread starts. */}
						{bot && <WatchingAvatar bot={bot} size={64} busy={threads.isPending} watching />}
						<h2 className="m-0 font-semibold text-2xl text-foreground tracking-tight">
							{greetingFor(waiting)}
						</h2>
					</div>
					{!bot ? (
						<EmptyState title={`${name} has no lead bot yet`}>
							Somebody who can change {name} chooses the bot that answers its threads.
						</EmptyState>
					) : (
						<ChatComposer
							label={`Message ${name}`}
							placeholder={`Ask ${bot.name} to…`}
							tall
							model={modelName}
							value={draft}
							onValueChange={setDraft}
							onSubmit={submit}
							submitLabel="Start thread"
							sending={threads.isPending}
							held={withoutModel.length > 0}
							notice={withoutModel.length > 0 && <BotsWithoutModelNotice bots={withoutModel} />}
							error={failed ? THREAD_NOT_STARTED : undefined}
							mentionable={mentionable}
							attachments={attachments}
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

/** How many of the bot's or project's open threads wait on the viewer, which its page greets them with. */
function useWaitingOnViewer(owner: ResourceOwner): number {
	const threads = useProjectThreads(resourceProjectId(owner)).data?.threads;
	return (threads ?? []).filter(
		(row) => row.conversation.doneAt === null && (row.needsApproval || row.mentionsYou),
	).length;
}

/** A bot as a mention names it. */
function botParticipantOf(bot: Bot): BotParticipant {
	return {
		kind: "bot",
		id: bot.id,
		name: bot.name,
		handle: bot.handle,
		color: bot.color,
		face: bot.face,
		shape: bot.shape,
	};
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
