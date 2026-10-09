import type { ChatListItem, Pod } from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { Library, Plus, Settings2 } from "lucide-react";
import { useState } from "react";
import { useChatList } from "@/lib/chats.ts";
import { agentChatLink, artifactsLink, podSettingsLink } from "@/lib/links.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { ListColumn } from "@/shell/ListColumn.tsx";
import { NewAgentDialog } from "@/shell/NewAgent.tsx";
import { CountBadge } from "@/ui/count-badge.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import { IconButton } from "@/ui/icon-button.tsx";

/**
 * The column of conversations for the pod chosen on the rail: one row per bot,
 * newest message first.
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
	const [creating, setCreating] = useState(false);
	const navigate = useNavigate();
	const newBot = pod.permissions.createAgents ? () => setCreating(true) : undefined;
	const emptyState: EmptyList = {
		title: `No bots in ${pod.name} yet`,
		hint: newBot ? undefined : "Someone who runs this pod can add one.",
		action: newBot ? { label: "New bot", onClick: newBot } : undefined,
	};
	const rows = list.data?.items ?? [];

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
	rows: readonly ChatListItem[];
	status: "loading" | "ready" | "failed";
	selectedAgentId?: string;
	/** Absent when the viewer may not make a bot here. */
	onNewBot?: () => void;
	emptyState: EmptyList;
	className?: string;
}) {
	const backToChat = useBackToHere("Chat");
	const title = pod.name;
	const empty = status === "ready" && rows.length === 0;

	return (
		<ListColumn
			title={title}
			className={className}
			actions={
				<>
					{onNewBot && !empty && (
						<IconButton label={`New bot in ${title}`} variant="bar" onClick={onNewBot}>
							<Plus size={17} strokeWidth={2.2} />
						</IconButton>
					)}
					<IconButton label="Artifacts" variant="bar" render={<Link {...artifactsLink(pod)} />}>
						<Library size={16} strokeWidth={2} />
					</IconButton>
					<IconButton
						label="Pod settings"
						variant="bar"
						render={<Link {...podSettingsLink(pod)} state={backToChat} />}
					>
						<Settings2 size={16} strokeWidth={2} />
					</IconButton>
				</>
			}
		>
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
				<ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-px overflow-y-auto px-2 pt-2.5 pb-3">
					{status === "failed" && (
						<li className="px-2.5 py-3 text-muted-foreground">Could not load these chats.</li>
					)}
					{rows.map((row) => (
						<li key={row.agent.id}>
							<ConversationRow row={row} pod={pod} selected={row.agent.id === selectedAgentId} />
						</li>
					))}
				</ul>
			)}
		</ListColumn>
	);
}

/**
 * A bot's chat on one line: its face and name, bright while something there is
 * new or waits on the viewer, and at the end what does.
 */
function ConversationRow({
	row,
	pod,
	selected,
}: {
	row: ChatListItem;
	pod: Pod;
	selected: boolean;
}) {
	const { agent } = row;
	const lit = selected || row.needsApproval || row.unreadMessages > 0;
	return (
		<Link
			{...agentChatLink({ pod, agent })}
			aria-current={selected ? "page" : undefined}
			className={cn(
				"focus-ring flex min-h-10 items-center gap-3 rounded-tail px-2.5 transition-colors",
				selected ? "bg-row-selected" : "hover:bg-row-hover",
			)}
		>
			<AgentAvatar color={agent.color} face={agent.face} size={26} className="shrink-0" />
			<span
				className={cn(
					"min-w-0 flex-1 truncate text-[14.5px]",
					lit ? "font-semibold text-foreground" : "font-medium text-muted-foreground",
				)}
			>
				{agent.name}
			</span>
			<ChatMarker needsApproval={row.needsApproval} unreadMessages={row.unreadMessages} />
		</Link>
	);
}

/**
 * What a chat's row says of it, at the end of its preview: that it needs
 * the viewer's decision, otherwise how many messages are unread.
 */
function ChatMarker({
	needsApproval,
	unreadMessages,
}: {
	needsApproval: boolean;
	unreadMessages: number;
}) {
	if (needsApproval) {
		return (
			<span className="flex h-5 shrink-0 items-center rounded-tail bg-primary px-[7px] font-semibold text-[11.5px] text-primary-foreground">
				Needs you
			</span>
		);
	}
	if (unreadMessages === 0) return null;
	return (
		<CountBadge
			count={unreadMessages}
			label={unreadMessages === 1 ? "1 unread message" : `${unreadMessages} unread messages`}
			size="md"
		/>
	);
}
