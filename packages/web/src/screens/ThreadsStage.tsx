import type { Agent, ChatListItem, Pod } from "@sugabots/contracts";
import { Link, useParams } from "@tanstack/react-router";
import { cn } from "cn";
import { formatDistanceToNowStrict } from "date-fns";
import { Check, MessagesSquare } from "lucide-react";
import { useChatList } from "@/lib/chats.ts";
import { conversationLink, type ThreadsTab } from "@/lib/links.ts";
import { Stage, StageMark } from "@/shell/Stage.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { SegmentedControl } from "@/ui/segmented-control.tsx";
import { ParticipantFaces } from "./ParticipantFaces.tsx";

/**
 * A bot's threads, open large beside its channel as its routines are: those
 * still going, or those done, newest first, each with when it last moved and
 * its latest message. Each opens in the chat with this kept open beside it,
 * so the next can be opened from here too.
 */
export function ThreadsStage({
	agent,
	pod,
	tab,
	onTabChange,
	onClose,
}: {
	agent: Agent;
	pod: Pod;
	tab: ThreadsTab;
	onTabChange: (tab: ThreadsTab) => void;
	onClose: () => void;
}) {
	const list = useChatList(pod.slug);
	const all = list.data?.threads.filter((row) => row.agent?.id === agent.id) ?? [];
	const going = all.filter((row) => row.conversation.doneAt === null);
	const done = all.filter((row) => row.conversation.doneAt !== null);
	const shown = tab === "done" ? done : going;
	const title = `${agent.name}'s threads`;
	return (
		<Stage
			label={title}
			icon={
				<StageMark>
					<MessagesSquare strokeWidth={2} />
				</StageMark>
			}
			title={title}
			onClose={onClose}
		>
			<div className="flex min-h-0 flex-1 flex-col gap-3">
				<SegmentedControl
					label="Which threads"
					options={[
						{ value: "open", label: `Open · ${going.length}` },
						{ value: "done", label: `Done · ${done.length}` },
					]}
					value={tab}
					onChange={onTabChange}
					className="self-start"
				/>
				{list.isError ? (
					<EmptyState title="Could not load these threads">
						The API did not answer. Reload this page to try again.
					</EmptyState>
				) : list.isSuccess && shown.length === 0 ? (
					<EmptyState title={tab === "done" ? "No done threads" : "No open threads"}>
						{tab === "done"
							? `Threads with ${agent.name} you mark done show here.`
							: `Start one with the + beside ${agent.name} in the sidebar.`}
					</EmptyState>
				) : (
					<ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-px overflow-y-auto p-0">
						{shown.map((row) => (
							<li key={row.conversation.id}>
								<ThreadListRow pod={pod} row={row} tab={tab} />
							</li>
						))}
					</ul>
				)}
			</div>
		</Stage>
	);
}

/**
 * A thread in the list: its title, ticked when done, and when it last moved;
 * under it, the faces of who is in it and its latest message. Shaded while it
 * is the chat open.
 */
function ThreadListRow({ pod, row, tab }: { pod: Pod; row: ChatListItem; tab: ThreadsTab }) {
	const { conversation: openId } = useParams({ strict: false });
	const selected = openId === row.conversation.id;
	const done = row.conversation.doneAt !== null;
	const lit = !done && row.unreadMessages > 0;
	return (
		<Link
			{...conversationLink({ pod, conversationId: row.conversation.id }, { threads: tab })}
			aria-current={selected ? "page" : undefined}
			className={cn(
				"focus-ring flex min-w-0 flex-col gap-0.5 rounded-lg px-2.5 py-2 transition-colors",
				selected ? "bg-row-selected" : "hover:bg-row-hover",
			)}
		>
			<span className="flex min-w-0 items-center gap-2">
				{done && (
					<Check
						aria-hidden
						size={12}
						strokeWidth={2.25}
						className="shrink-0 text-subtle-foreground"
					/>
				)}
				<span
					className={cn(
						"min-w-0 flex-1 truncate text-sm",
						lit ? "font-semibold text-foreground" : "text-soft-foreground",
					)}
				>
					{row.conversation.title}
				</span>
				{row.lastMessage && <TimeAgo at={row.lastMessage.at} />}
			</span>
			{(row.participants.length > 0 || row.lastMessage) && (
				<span className="flex min-w-0 items-center gap-2">
					<ParticipantFaces
						participants={row.participants}
						size={16}
						// The row's own shade while it is open, so the rings match what is behind them.
						surface={selected ? "var(--row-selected)" : "var(--background)"}
					/>
					{row.lastMessage && (
						<span className="min-w-0 truncate text-subtle-foreground text-xs">
							{row.lastMessage.preview}
						</span>
					)}
				</span>
			)}
		</Link>
	);
}

/** How long ago `at` was, in words: "4 minutes ago", "18 days ago", "6 months ago". */
function TimeAgo({ at }: { at: string }) {
	return (
		<time dateTime={at} className="shrink-0 text-subtle-foreground text-xs">
			{formatDistanceToNowStrict(new Date(at), { addSuffix: true })}
		</time>
	);
}
