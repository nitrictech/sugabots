import type { Agent, Thread } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { Check, Clock3, History, SquarePen } from "lucide-react";
import { useAgentWithPod } from "@/lib/agents.ts";
import { agentChatLink } from "@/lib/links.ts";
import { threadsForAgent, useThreads } from "@/lib/threads.ts";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuLinkItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";

export function ThreadPicker({
	agent,
	podId,
	currentThreadId,
}: {
	agent: Pick<Agent, "id" | "name">;
	podId: string;
	currentThreadId: string;
}) {
	const query = useThreads();
	const placed = useAgentWithPod(agent.id);
	const threads = threadsForAgent(query.data, agent.id, podId);
	const groupedThreads = groupThreadsByDay(threads);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label="Thread history"
				className="focus-ring grid size-9 shrink-0 place-items-center rounded-xl bg-sunken text-muted-foreground hover:text-heading"
			>
				<History size={17} />
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				sideOffset={10}
				className="w-[min(340px,calc(100vw-24px))] overflow-hidden rounded-xl p-0"
			>
				<div className="max-h-[min(520px,var(--available-height))] overflow-y-auto px-3 pb-4 pt-2">
					{placed && (
						<DropdownMenuLinkItem
							className="min-h-9 gap-2.5 rounded-lg px-2.5 py-2 font-medium text-heading text-md"
							render={<Link {...agentChatLink(placed)} />}
						>
							<SquarePen size={15} />
							New thread
						</DropdownMenuLinkItem>
					)}
					<DropdownMenuSeparator />
					{query.error ? (
						<p className="px-2 py-4 text-muted-foreground text-sm">Threads could not be loaded.</p>
					) : groupedThreads.length === 0 ? (
						<p className="px-2 py-6 text-center text-muted-foreground text-sm">
							No threads with {agent.name} yet.
						</p>
					) : (
						groupedThreads.map(({ label, threads: threadsForDay }) => (
							<DropdownMenuGroup key={label}>
								<DropdownMenuLabel className="px-1 pb-1 pt-3 font-semibold text-subtle-foreground text-2xs uppercase tracking-[0.07em]">
									{label}
								</DropdownMenuLabel>
								{threadsForDay.map((thread) => (
									<DropdownMenuLinkItem
										key={thread.id}
										className={`min-h-9 gap-2.5 rounded-lg px-2.5 py-2 text-md ${
											thread.id === currentThreadId ? "bg-muted" : ""
										}`}
										render={
											<Link
												from="/$workspace"
												to="./threads/$thread"
												params={{ thread: thread.id }}
												search={{ summary: undefined }}
											/>
										}
									>
										<Clock3 size={15} />
										<span className="min-w-0 flex-1 truncate font-medium text-heading">
											{thread.title}
										</span>
										<time className="text-subtle-foreground text-xs" dateTime={thread.updatedAt}>
											{formatThreadTime(thread.updatedAt)}
										</time>
										{thread.id === currentThreadId && (
											<Check aria-label="Current thread" size={14} />
										)}
									</DropdownMenuLinkItem>
								))}
							</DropdownMenuGroup>
						))
					)}
				</div>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function groupThreadsByDay(threads: Thread[]): { label: string; threads: Thread[] }[] {
	const grouped = new Map<string, { label: string; threads: Thread[] }>();
	for (const thread of threads) {
		const date = new Date(thread.updatedAt);
		const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
		const existing = grouped.get(key);
		if (existing) {
			existing.threads.push(thread);
		} else {
			grouped.set(key, { label: formatThreadDay(date), threads: [thread] });
		}
	}
	return [...grouped.values()];
}

function formatThreadDay(date: Date): string {
	const today = new Date();
	if (sameDay(date, today)) return "Today";
	const yesterday = new Date(today);
	yesterday.setDate(today.getDate() - 1);
	if (sameDay(date, yesterday)) return "Yesterday";
	return new Intl.DateTimeFormat(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
	}).format(date);
}

function formatThreadTime(updatedAt: string): string {
	return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
		new Date(updatedAt),
	);
}

function sameDay(left: Date, right: Date): boolean {
	return (
		left.getFullYear() === right.getFullYear() &&
		left.getMonth() === right.getMonth() &&
		left.getDate() === right.getDate()
	);
}
