import type { Bot } from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { useState } from "react";
import { useModelName } from "@/lib/bots.ts";
import { TASK_NOT_STARTED, useBotTasks, useRecentTasks, useTaskStarter } from "@/lib/chats.ts";
import { useComposerAttachments } from "@/lib/composer-attachments.ts";
import { conversationLink } from "@/lib/links.ts";
import { formatListTime } from "@/lib/list-time.ts";
import { countOf } from "@/lib/name-list.ts";
import { useSidebarHiddenBesideChat } from "@/lib/sidebar-hidden.tsx";
import { BotAvatar, WatchingAvatar } from "@/shell/Bot.tsx";
import { BotCrumb } from "@/shell/BotCrumb.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { ChatComposer } from "./ChatComposer.tsx";
import { PeopleChatHeader } from "./ChatHeader.tsx";
import { groupMentionsBy } from "./mentions.tsx";

/** How many of the tasks you've been working on a Personal Assistant's page lists. */
const RECENT_TASKS_SHOWN = 5;

/**
 * A bot's own page, where a task with it starts from its first message: its
 * face, what of its work waits on the viewer, and the box to give it something
 * new. Sending starts the task and opens it. Files are added once it has
 * started. A Personal Assistant's page, the workspace's home, also lists the
 * tasks the viewer has been working on lately.
 */
export function NewTask({ bot, userId }: { bot: Bot; userId: string }) {
	// A task has nowhere to upload to until it starts.
	const attachments = useComposerAttachments(undefined);
	const tasks = useTaskStarter(bot.id);
	const navigate = useNavigate();
	const [draft, setDraft] = useState("");
	const [failed, setFailed] = useState(false);
	const modelName = useModelName(bot.model);
	// What of the bot's work waits on the viewer, which its page greets them with.
	const waiting = (useBotTasks(bot.id).data?.tasks ?? []).filter(
		(row) => row.conversation.doneAt === null && (row.needsApproval || row.mentionsYou),
	).length;
	// The page names itself in its middle; the header is kept on a phone for its Back.
	const header = (
		<div className="md:hidden">
			<PeopleChatHeader title="New task" back={{ to: "bot", bot }} />
		</div>
	);
	const mentionable = groupMentionsBy({ kind: "person", id: userId }, [], "task");

	async function submit() {
		setFailed(false);
		const started = await tasks.start(draft);
		if (started.outcome === "refused") setFailed(true);
		if (started.outcome !== "started") return;
		await navigate(conversationLink({ bot, conversationId: started.task.conversation.id }));
	}

	return (
		<div className="flex min-w-0 flex-1 flex-col">
			{header}
			<BotPageBar bot={bot} />
			<div className="flex min-h-0 flex-1 flex-col items-center justify-end overflow-y-auto px-5 pb-16 md:justify-center md:pb-24">
				<div className="flex w-full max-w-180 flex-col items-center gap-6">
					<div className="flex flex-col items-center gap-3 text-center">
						{/* It watches the request being written, and thinks while the task starts. */}
						<WatchingAvatar bot={bot} size={64} busy={tasks.isPending} watching />
						<h2 className="m-0 font-semibold text-2xl text-foreground tracking-tight">
							{greetingFor(waiting)}
						</h2>
					</div>
					{bot.model === null ? (
						<EmptyState title={`${bot.name} has no model yet`}>
							Somebody who can change {bot.name} chooses its model in its settings.
						</EmptyState>
					) : (
						<ChatComposer
							label={`Message ${bot.name}`}
							placeholder={`Ask ${bot.name} to…`}
							pill
							tall
							model={modelName ?? undefined}
							value={draft}
							onValueChange={setDraft}
							onSubmit={submit}
							submitLabel="Start task"
							sending={tasks.isPending}
							needsText
							error={failed ? TASK_NOT_STARTED : undefined}
							className="w-full"
							mentionable={mentionable}
							attachments={attachments}
						/>
					)}
					{bot.assistant && <RecentTasks userId={userId} />}
				</div>
			</div>
		</div>
	);
}

/**
 * From a tablet up, the top of a bot's page: its breadcrumb, the bot alone,
 * clear of the sidebar's button while the sidebar is away.
 */
function BotPageBar({ bot }: { bot: Bot }) {
	const sidebarHidden = useSidebarHiddenBesideChat();
	return (
		<div
			className={cn(
				"hidden h-13 shrink-0 items-center pr-4 transition-all duration-300 ease-out md:flex",
				sidebarHidden ? "pl-14" : "pl-6",
			)}
		>
			<BotCrumb bot={bot} />
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
 * On a Personal Assistant's page, under where something new starts: the tasks
 * the viewer has been working on lately, each with its bot, how it stands and
 * when it last moved.
 */
function RecentTasks({ userId }: { userId: string }) {
	const recent = useRecentTasks(userId, RECENT_TASKS_SHOWN);
	if (recent.length === 0) return null;
	return (
		<section aria-label="Recent tasks" className="flex w-full flex-col gap-1 pt-4">
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
							{(row.needsApproval || row.mentionsYou) && (
								<span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
							)}
						</Link>
					</li>
				))}
			</ul>
		</section>
	);
}
