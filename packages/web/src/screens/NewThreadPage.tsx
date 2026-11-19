import type { Bot, BotParticipant } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { useState } from "react";
import { useModelName } from "@/lib/bots.ts";
import {
	THREAD_NOT_STARTED,
	useBotThreads,
	useProjectThreads,
	useRecentThreads,
	useThreadStarter,
} from "@/lib/chats.ts";
import { useComposerAttachments } from "@/lib/composer-attachments.ts";
import { conversationLink } from "@/lib/links.ts";
import { formatListTime } from "@/lib/list-time.ts";
import { countOf } from "@/lib/name-list.ts";
import { useProjectBots } from "@/lib/projects.ts";
import {
	ownerName,
	type ResourceOwner,
	useLeadBot,
	useNavigateToOwnerPage,
} from "@/lib/resource-owner.tsx";
import { useSidebarHiddenBesideChat } from "@/lib/sidebar-hidden.tsx";
import { BotAvatar, WatchingAvatar } from "@/shell/Bot.tsx";
import { OwnerCrumb } from "@/shell/BotCrumb.tsx";
import { AttentionDot } from "@/ui/attention-dot.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { ChatComposer } from "./ChatComposer.tsx";
import { PlainChatHeader } from "./ChatHeader.tsx";
import { groupMentionsBy, type MentionTarget } from "./mentions.tsx";

/** How many of the threads you've been working on a Personal Assistant's page lists. */
const RECENT_THREADS_SHOWN = 5;

/**
 * Where a thread starts from its first message: a bot's own page, or a
 * project's new thread. Its bot's face (a project's lead bot's), what of the
 * work there waits on the viewer, and the box to give it something new.
 * Sending starts the thread and opens it. Files are added once it has started.
 * A Personal Assistant's page, the workspace's home, also lists the threads
 * the viewer has been working on lately.
 */
export function NewThreadPage({ owner, userId }: { owner: ResourceOwner; userId: string }) {
	// A thread has nowhere to upload to until it starts.
	const attachments = useComposerAttachments(undefined);
	const threads = useThreadStarter(
		"bot" in owner ? { botId: owner.bot.id } : { projectId: owner.project.id },
	);
	const navigateToOwnerPage = useNavigateToOwnerPage();
	const [draft, setDraft] = useState("");
	const [failed, setFailed] = useState(false);
	// The bot that answers: the bot itself, or the project's lead bot.
	const bot = useLeadBot(owner);
	const modelName = useModelName(bot?.model ?? null);
	const name = ownerName(owner);
	const waiting = useWaitingOnViewer(owner);
	const projectBots = useProjectBots("project" in owner ? owner.project.id : undefined).data;
	// The page names itself in its middle; the header is kept on a phone for its Back.
	const header = (
		<div className="md:hidden">
			<PlainChatHeader
				title="New thread"
				back={
					"bot" in owner ? { to: "bot", bot: owner.bot } : { to: "project", project: owner.project }
				}
			/>
		</div>
	);
	// In a project, its bots can be brought in by name from the first message.
	const mentionable: MentionTarget[] = [
		...(projectBots ?? []).map(botParticipantOf),
		...groupMentionsBy({ kind: "person", id: userId }, [], "project_thread"),
	];

	async function submit() {
		setFailed(false);
		const started = await threads.start(draft);
		if (started.outcome === "refused") setFailed(true);
		if (started.outcome !== "started") return;
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
					) : bot.model === null ? (
						<EmptyState title={`${bot.name} has no model yet`}>
							Somebody who can change {bot.name} chooses its model in its settings.
						</EmptyState>
					) : (
						<ChatComposer
							label={`Message ${name}`}
							placeholder={`Ask ${bot.name} to…`}
							pill
							tall
							model={modelName ?? undefined}
							value={draft}
							onValueChange={setDraft}
							onSubmit={submit}
							submitLabel="Start thread"
							sending={threads.isPending}
							needsText
							error={failed ? THREAD_NOT_STARTED : undefined}
							mentionable={mentionable}
							attachments={attachments}
						/>
					)}
					{"bot" in owner && owner.bot.assistant && <RecentThreads userId={userId} />}
				</div>
			</div>
		</div>
	);
}

/** How many of the bot's or project's open threads wait on the viewer, which its page greets them with. */
function useWaitingOnViewer(owner: ResourceOwner): number {
	const botThreads = useBotThreads("bot" in owner ? owner.bot.id : undefined).data?.threads;
	const projectThreads = useProjectThreads("project" in owner ? owner.project.slug : undefined).data
		?.chats;
	return (("bot" in owner ? botThreads : projectThreads) ?? []).filter(
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

/**
 * On a Personal Assistant's page, under where something new starts: the threads
 * the viewer has been working on lately, each with its bot, how it stands and
 * when it last moved.
 */
function RecentThreads({ userId }: { userId: string }) {
	const recent = useRecentThreads(userId, RECENT_THREADS_SHOWN);
	if (recent.length === 0) return null;
	return (
		<section aria-label="Recent threads" className="flex w-full flex-col gap-1 pt-4">
			<h3 className="m-0 px-2 pb-1 font-normal text-subtle-foreground text-xs">Recent</h3>
			<ul className="m-0 flex list-none flex-col p-0">
				{recent.map((row) => (
					<li key={row.conversation.id} className="border-border border-b last:border-b-0">
						<Link
							{...conversationLink({ bot: row.bot, conversationId: row.conversation.id })}
							className="focus-ring flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-row-hover"
						>
							<span aria-hidden className="flex shrink-0">
								<BotAvatar
									color={row.bot.color}
									face={row.bot.face}
									shape={row.bot.shape}
									size={32}
								/>
							</span>
							<span className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span
									className={cn(
										"truncate text-sm",
										row.unreadMessages > 0
											? "font-semibold text-foreground"
											: "text-soft-foreground",
									)}
								>
									{row.conversation.title}
								</span>
								<span className="truncate text-subtle-foreground text-xs">
									{[
										row.bot.name,
										row.needsApproval
											? "Needs your approval"
											: row.mentionsYou
												? "Mentions you"
												: row.unreadMessages > 0
													? countOf(row.unreadMessages, "new message", "new messages")
													: undefined,
										formatListTime(
											new Date(row.lastMessage?.at ?? row.conversation.createdAt),
											new Date(),
										),
									]
										.filter(Boolean)
										.join(" · ")}
								</span>
							</span>
							{(row.needsApproval || row.mentionsYou) && <AttentionDot attention="needsYou" />}
						</Link>
					</li>
				))}
			</ul>
		</section>
	);
}
