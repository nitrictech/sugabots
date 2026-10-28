import type { Agent, ChatListItem, Pod } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronLeft, RefreshCcw, SquarePen } from "lucide-react";
import { useChatList } from "@/lib/chats.ts";
import { conversationLink, newThreadLink, podLink, routinesLink } from "@/lib/links.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { ListTime } from "@/shell/Page.tsx";

/**
 * A bot's page on a phone: Back to its pod and a new thread with it, then its
 * name, its routines, and its threads, newest first, each with when and what
 * was said last, notched at the left while something in it is new.
 */
export function MobileBotPage({ pod, agent }: { pod: Pod; agent: Agent }) {
	const list = useChatList(pod.slug);
	const threads = (list.data?.threads ?? []).filter(
		(row) => row.agent?.id === agent.id && row.conversation.doneAt === null,
	);
	const routines = (list.data?.routines ?? []).filter((row) => row.agent.id === agent.id);
	return (
		<section aria-label={agent.name} className="flex min-h-0 min-w-0 flex-1 flex-col">
			<div className="flex shrink-0 items-center justify-between px-4 pt-[calc(env(safe-area-inset-top)+16px)]">
				<Link
					{...podLink(pod)}
					aria-label={`Back to ${pod.name}`}
					className="focus-ring glass grid size-9 place-items-center rounded-full text-foreground"
				>
					<ChevronLeft aria-hidden size={18} strokeWidth={2.25} />
				</Link>
				<Link
					{...newThreadLink(pod, agent)}
					aria-label={`New thread with ${agent.name}`}
					className="focus-ring glass grid size-9 place-items-center rounded-full text-foreground"
				>
					<SquarePen aria-hidden size={17} strokeWidth={1.75} />
				</Link>
			</div>
			<div className="flex shrink-0 items-center gap-3 px-5 pt-[18px] pb-2.5">
				<AgentAvatar color={agent.color} face={agent.face} shape={agent.shape} size={36} />
				<h1 className="m-0 min-w-0 truncate font-semibold text-[28px] tracking-[-0.02em]">
					{agent.name}
				</h1>
			</div>
			<ul className="m-0 flex min-h-0 flex-1 list-none flex-col overflow-y-auto p-0 pb-4">
				<li>
					<Link
						{...routinesLink(pod, agent)}
						className="focus-ring flex items-center gap-3 px-5 py-3 text-[16px] text-muted-foreground active:bg-row-hover"
					>
						<RefreshCcw aria-hidden size={18} strokeWidth={1.75} className="shrink-0" />
						<span className="flex-1">Routines</span>
						{routines.length > 0 && (
							<span className="text-[13px] text-subtle-foreground tabular-nums">
								{routines.length}
							</span>
						)}
						{routines.some((row) => row.routine.failed) && (
							<span className="size-1.5 rounded-full bg-destructive-text">
								<span className="sr-only">A routine's latest run failed</span>
							</span>
						)}
					</Link>
				</li>
				{threads.map((row) => (
					<li key={row.conversation.id}>
						<ThreadRow pod={pod} row={row} />
					</li>
				))}
				{list.isSuccess && threads.length === 0 && (
					<li className="flex flex-col items-center gap-3.5 px-8 py-16 text-center">
						<span className="text-[14px] text-muted-foreground">
							No threads with {agent.name} yet.
						</span>
						<Link
							{...newThreadLink(pod, agent)}
							className="focus-ring rounded-[8px] bg-chip px-4 py-2 font-medium text-[14px] text-foreground"
						>
							Start a thread
						</Link>
					</li>
				)}
			</ul>
		</section>
	);
}

/** One of the bot's threads: its title and when, and under them what was said last. */
function ThreadRow({ pod, row }: { pod: Pod; row: ChatListItem }) {
	const unread = row.unreadMessages > 0 || row.needsApproval;
	return (
		<Link
			{...conversationLink({ pod, conversationId: row.conversation.id })}
			className="focus-ring relative flex flex-col gap-[3px] px-5 py-3 active:bg-row-hover"
		>
			{unread && (
				<span
					aria-hidden
					className="absolute top-1/2 left-0 h-2 w-1 -translate-y-1/2 rounded-r bg-foreground"
				/>
			)}
			<span className="flex w-full items-baseline gap-3">
				<span
					className={cn(
						"min-w-0 flex-1 truncate text-[16px]",
						unread ? "font-semibold text-foreground" : "text-soft-foreground",
					)}
				>
					{row.conversation.title}
				</span>
				<ListTime at={row.lastMessage?.at ?? row.conversation.updatedAt} className="text-[13px]" />
			</span>
			{row.lastMessage && (
				<span className="truncate text-[14px] text-subtle-foreground">
					{row.lastMessage.preview}
				</span>
			)}
			{unread && <span className="sr-only">, unread</span>}
		</Link>
	);
}
