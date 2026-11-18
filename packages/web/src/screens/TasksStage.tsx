import type { Bot, ChatListItem } from "@sugabots/contracts";
import { Link, useParams } from "@tanstack/react-router";
import { cn } from "cn";
import { formatDistanceToNowStrict } from "date-fns";
import { Check, MessagesSquare } from "lucide-react";
import { useBotTasks } from "@/lib/chats.ts";
import { conversationLink, type TasksTab } from "@/lib/links.ts";
import { Stage, StageMark } from "@/shell/Stage.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { SegmentedControl } from "@/ui/segmented-control.tsx";
import { ParticipantFaces } from "./ParticipantFaces.tsx";

/**
 * A bot's tasks, open large beside a task as its automations are: what it
 * has been doing lately, then its tasks still going, or those done, newest first, each with when it last moved and
 * its latest message. Each opens in the chat with this kept open beside it,
 * so the next can be opened from here too.
 */
export function TasksStage({
	bot,
	tab,
	onTabChange,
	onClose,
}: {
	bot: Bot;
	tab: TasksTab;
	onTabChange: (tab: TasksTab) => void;
	onClose: () => void;
}) {
	const list = useBotTasks(bot.id);
	const all = list.data?.tasks ?? [];
	const going = all.filter((row) => row.conversation.doneAt === null);
	const done = all.filter((row) => row.conversation.doneAt !== null);
	const shown = tab === "done" ? done : going;
	const title = `${bot.name}'s tasks`;
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
				{list.data?.summary && (
					<section
						aria-label="Lately"
						className="flex flex-col gap-1 rounded-lg bg-row-hover px-3 py-2.5"
					>
						<span className="flex items-center gap-2 font-medium text-muted-foreground text-xs">
							Lately
							<TimeAgo at={list.data.summary.updatedAt} />
						</span>
						<p className="m-0 text-soft-foreground text-sm">{list.data.summary.content}</p>
					</section>
				)}
				<SegmentedControl
					label="Which tasks"
					options={[
						{ value: "open", label: `Open · ${going.length}` },
						{ value: "done", label: `Done · ${done.length}` },
					]}
					value={tab}
					onChange={onTabChange}
					className="self-start"
				/>
				{list.isError ? (
					<EmptyState title="Could not load these tasks">
						The API did not answer. Reload this page to try again.
					</EmptyState>
				) : list.isSuccess && shown.length === 0 ? (
					<EmptyState title={tab === "done" ? "No done tasks" : "No open tasks"}>
						{tab === "done"
							? `Tasks with ${bot.name} you mark done show here.`
							: `Start one with the + beside ${bot.name} in the sidebar.`}
					</EmptyState>
				) : (
					<ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-px overflow-y-auto p-0">
						{shown.map((row) => (
							<li key={row.conversation.id}>
								<TaskListRow bot={bot} row={row} tab={tab} />
							</li>
						))}
					</ul>
				)}
			</div>
		</Stage>
	);
}

/**
 * A task in the list: its title, ticked when done, and when it last moved;
 * under it, the faces of who is in it and its latest message. Shaded while it
 * is the chat open.
 */
function TaskListRow({ bot, row, tab }: { bot: Bot; row: ChatListItem; tab: TasksTab }) {
	const { conversation: openId } = useParams({ strict: false });
	const selected = openId === row.conversation.id;
	const done = row.conversation.doneAt !== null;
	const lit = !done && row.unreadMessages > 0;
	return (
		<Link
			{...conversationLink({ bot, conversationId: row.conversation.id }, { tasks: tab })}
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
