import type { ChatListItem, Pod } from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { Hand, Plus, Search, Settings } from "lucide-react";
import { useState } from "react";
import { useChatList } from "@/lib/chats.ts";
import { agentChatLink, podSettingsLink } from "@/lib/links.ts";
import { formatListTime } from "@/lib/list-time.ts";
import { useSession } from "@/lib/session.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { waitingText } from "@/lib/tool-names.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { NewAgentDialog } from "@/shell/NewAgent.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";

/**
 * The column of conversations for the pod chosen on the rail: one row per bot,
 * newest message first, with a search over their names.
 */
export function ConversationList({
	pod,
	selectedAgentId,
	className,
}: {
	pod: Pod;
	selectedAgentId?: string;
	className?: string;
}) {
	const list = useChatList(pod.slug);
	const session = useSession();
	const [creating, setCreating] = useState(false);
	const navigate = useNavigate();
	const newBot = pod.permissions.createAgents ? () => setCreating(true) : undefined;
	const emptyState: EmptyList = {
		title: `No bots in ${pod.name} yet`,
		hint: newBot ? undefined : "Someone who runs this pod can add one.",
		action: newBot ? { label: "New bot", onClick: newBot } : undefined,
	};
	const rows = (list.data?.items ?? []).map(
		(item): ConversationRowData => ({
			...item,
			fromYou: item.lastMessage?.authorUserId === session.user?.id,
		}),
	);

	return (
		<>
			<ConversationListView
				pod={pod}
				rows={rows}
				status={list.isError ? "failed" : list.isSuccess ? "ready" : "loading"}
				selectedAgentId={selectedAgentId}
				onNewBot={newBot}
				emptyState={emptyState}
				className={className}
			/>
			<Dialog open={creating} onOpenChange={setCreating}>
				<NewAgentDialog
					podId={pod.id}
					pods={[pod]}
					onCreated={async (agent) => {
						setCreating(false);
						await navigate(agentChatLink({ pod, agent }));
					}}
				/>
			</Dialog>
		</>
	);
}

/** What an empty list says, and the one thing that would fill it. */
export interface EmptyList {
	title: string;
	/** For when there is nothing the viewer can do themselves, or it needs a word of why. */
	hint?: string;
	action?: { label: string; onClick: () => void };
}

/** A list row with whether you wrote the last message resolved. */
export interface ConversationRowData extends ChatListItem {
	fromYou: boolean;
}

export function ConversationListView({
	pod,
	rows,
	status,
	selectedAgentId,
	onNewBot,
	emptyState,
	className,
}: {
	pod: Pod;
	rows: readonly ConversationRowData[];
	status: "loading" | "ready" | "failed";
	selectedAgentId?: string;
	/** Absent when the viewer may not make a bot here. */
	onNewBot?: () => void;
	emptyState: EmptyList;
	className?: string;
}) {
	const backToChat = useBackToHere("Chat");
	const title = pod.name;
	const [query, setQuery] = useState("");
	const needle = query.trim().toLowerCase();
	const shown = needle ? rows.filter((row) => row.agent.name.toLowerCase().includes(needle)) : rows;
	const empty = status === "ready" && rows.length === 0;

	return (
		<section
			aria-label={title}
			className={cn(
				"flex min-h-0 min-w-0 flex-1 flex-col border-border border-r bg-list md:w-[280px] md:flex-none lg:w-80",
				className,
			)}
		>
			<header className="flex shrink-0 items-center gap-2.5 px-4 pt-5 pb-3">
				<h1 className="m-0 min-w-0 flex-1 truncate font-extrabold text-[30px] text-foreground tracking-[-0.02em] md:text-xl">
					{title}
				</h1>
				{onNewBot && !empty && (
					<Tooltip label="New bot">
						<button
							type="button"
							aria-label="New bot"
							onClick={onNewBot}
							className="focus-ring grid size-[34px] shrink-0 place-items-center rounded-full bg-chip text-foreground transition-colors hover:bg-hover"
						>
							<Plus size={18} strokeWidth={2.4} />
						</button>
					</Tooltip>
				)}
				<Tooltip label="Pod settings">
					<Link
						{...podSettingsLink(pod)}
						state={backToChat}
						aria-label="Pod settings"
						className="focus-ring grid size-[34px] shrink-0 place-items-center rounded-full bg-chip text-foreground transition-colors hover:bg-hover"
					>
						<Settings size={17} strokeWidth={2.2} />
					</Link>
				</Tooltip>
			</header>

			{empty ? (
				// A little above the middle, as the design sets it, with the one next step under it.
				<div className="flex flex-1 flex-col items-center justify-center gap-3.5 px-6 pb-[18%] text-center">
					<div className="flex flex-col gap-1.5">
						<p className="m-0 font-medium text-[14.5px] text-muted-foreground">
							{emptyState.title}
						</p>
						{emptyState.hint && (
							<p className="m-0 max-w-[240px] text-[13px] text-subtle-foreground leading-normal">
								{emptyState.hint}
							</p>
						)}
					</div>
					{emptyState.action && (
						<button
							type="button"
							onClick={emptyState.action.onClick}
							className="focus-ring flex h-10 items-center gap-[7px] rounded-[20px] bg-switch-on px-[18px] font-semibold text-[14px] text-white transition-colors hover:bg-primary"
						>
							<Plus size={15} strokeWidth={2.6} />
							{emptyState.action.label}
						</button>
					)}
				</div>
			) : (
				<>
					<div className="shrink-0 px-2 pb-2.5">
						<label className="focus-ring-within flex items-center gap-[9px] rounded-xl border border-transparent bg-chip px-2.5">
							<Search aria-hidden size={15} className="shrink-0 text-muted-foreground" />
							<input
								type="search"
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder={`Search ${title}`}
								aria-label={`Search ${title}`}
								className="min-w-0 flex-1 bg-transparent py-[9px] text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
							/>
						</label>
					</div>
					<ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-px overflow-y-auto px-2 pt-0.5 pb-3">
						{status === "failed" && (
							<li className="px-2.5 py-3 text-muted-foreground">Could not load these chats.</li>
						)}
						{shown.map((row) => (
							<li key={row.agent.id}>
								<ConversationRow row={row} pod={pod} selected={row.agent.id === selectedAgentId} />
							</li>
						))}
						{needle && status === "ready" && shown.length === 0 && (
							<li className="px-2.5 py-3 text-muted-foreground">No bots match “{query.trim()}”.</li>
						)}
					</ul>
				</>
			)}
		</section>
	);
}

function ConversationRow({
	row,
	pod,
	selected,
}: {
	row: ConversationRowData;
	pod: Pod;
	selected: boolean;
}) {
	const { agent, lastMessage } = row;

	return (
		<Link
			{...agentChatLink({ pod, agent })}
			aria-current={selected ? "page" : undefined}
			className={cn(
				"focus-ring flex items-center gap-3 rounded-[14px] px-2.5 py-[9px] transition-colors",
				selected ? "bg-row-selected" : "hover:bg-row-hover",
			)}
		>
			<span className="relative size-11 shrink-0">
				<AgentAvatar color={agent.color} face={agent.face} size={44} />
				<ChatMarker needsApproval={row.needsApproval} unread={row.unread} selected={selected} />
			</span>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="flex items-baseline gap-2">
					<span
						className={cn(
							"min-w-0 flex-1 truncate text-[14.5px] text-foreground",
							row.unread ? "font-bold" : "font-semibold",
						)}
					>
						{agent.name}
					</span>
					{lastMessage && (
						// A step lighter on the chosen row, whose wash would take the faint time below AA.
						<time
							dateTime={lastMessage.at}
							className={cn(
								"shrink-0 text-xs",
								selected ? "text-muted-foreground" : "text-subtle-foreground",
							)}
						>
							{formatListTime(new Date(lastMessage.at), new Date())}
						</time>
					)}
				</span>
				<span
					className={cn(
						"truncate text-md",
						row.unread ? "font-medium text-foreground" : "text-muted-foreground",
					)}
				>
					{row.waitingOn
						? waitingText(row.waitingOn)
						: lastMessage
							? `${row.fromYou ? "You: " : ""}${lastMessage.preview}`
							: "No messages yet"}
				</span>
			</span>
		</Link>
	);
}

/**
 * What a chat's face says about it, top right: a hand when it waits
 * for a decision the person may make, otherwise a dot when it is unread. Each
 * sits in the row's colour so it stands off the face.
 */
function ChatMarker({
	needsApproval,
	unread,
	selected,
}: {
	needsApproval: boolean;
	unread: boolean;
	/** Whether the row is the open chat, whose wash the ring matches. */
	selected: boolean;
}) {
	const ring = selected
		? "shadow-[0_0_0_2.5px_var(--row-selected)]"
		: "shadow-[0_0_0_2.5px_var(--list)]";
	if (needsApproval) {
		return (
			<span
				className={cn(
					"absolute -top-[3px] -right-[3px] grid size-[20px] place-items-center rounded-full bg-approval-marker text-white",
					ring,
				)}
			>
				<Hand aria-hidden size={12} strokeWidth={2.4} />
				<span className="sr-only">Needs your approval</span>
			</span>
		);
	}
	if (unread) {
		return (
			<span className={cn("absolute top-0 right-0 size-3 rounded-full bg-unread-dot", ring)}>
				<span className="sr-only">Unread</span>
			</span>
		);
	}
	return null;
}
