import type { Agent, ChatListItem, Pod } from "@sugabots/contracts";
import { Link, useNavigate, useRouteContext } from "@tanstack/react-router";
import { cn } from "cn";
import { Plus, Search } from "lucide-react";
import { useState } from "react";
import { useAgents } from "@/lib/agents.ts";
import { useChatList } from "@/lib/chats.ts";
import { agentChatLink, allAgentChatLink, podLink } from "@/lib/links.ts";
import { formatListTime } from "@/lib/list-time.ts";
import { usePods } from "@/lib/pods.ts";
import { useWorkspacePermissions } from "@/lib/workspace.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { NewAgentDialog } from "@/shell/NewAgent.tsx";
import { NewPodDialog } from "@/shell/NewPod.tsx";
import { PodTile } from "@/shell/PodTile.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";

/** What a list covers: every shared pod, or one pod. */
export type ListScope = { kind: "all" } | { kind: "pod"; pod: Pod };

/**
 * The column of conversations for the pod chosen on the rail: one row per bot,
 * newest message first, with a search over their names. In All, each row
 * carries its pod's badge, since the bots come from several.
 */
export function ConversationList({
	scope,
	selectedAgentId,
	className,
}: {
	scope: ListScope;
	selectedAgentId?: string;
	className?: string;
}) {
	const list = useChatList(scope.kind === "all" ? "all" : scope.pod.id);
	const { session } = useRouteContext({ from: "__root__" });
	const { data: pods } = usePods();
	const { agents } = useAgents();
	const may = useWorkspacePermissions();
	const [creating, setCreating] = useState<"bot" | "pod">();
	const navigate = useNavigate();
	const pod = scope.kind === "pod" ? scope.pod : undefined;
	const shared = pods?.filter((one) => one.kind === "shared") ?? [];
	// In All a new bot goes in whichever shared pod you pick, of those you may add to.
	const podsToAddTo = (pod ? [pod] : shared).filter((one) => one.permissions.createAgents);
	const newBot = podsToAddTo.length > 0 ? () => setCreating("bot") : undefined;
	const emptyState: EmptyList =
		scope.kind === "all" && shared.length === 0
			? {
					title: "No pods yet",
					hint: may.createPods
						? "A pod is where a team's bots live. Make one to start."
						: "Ask a workspace admin to add you to a pod.",
					action: may.createPods
						? { label: "New pod", onClick: () => setCreating("pod") }
						: undefined,
				}
			: {
					title: scope.kind === "all" ? "No bots yet" : `No bots in ${scope.pod.name} yet`,
					hint: newBot ? undefined : "Someone who runs this pod can add one.",
					action: newBot ? { label: "New bot", onClick: newBot } : undefined,
				};

	const rows = (list.data?.items ?? []).flatMap((item): ConversationRowData[] => {
		const home = pods?.find((one) => one.id === item.agent.podId);
		if (!home) return [];
		return [
			{
				...item,
				pod: home,
				podBots: crewOf(agents, home),
				fromYou: item.lastMessage?.authorUserId === session.user?.id,
			},
		];
	});

	return (
		<>
			<ConversationListView
				title={scope.kind === "all" ? "All" : scope.pod.name}
				inAll={scope.kind === "all"}
				rows={rows}
				status={list.isError ? "failed" : list.isSuccess ? "ready" : "loading"}
				selectedAgentId={selectedAgentId}
				onNewBot={newBot}
				emptyState={emptyState}
				className={className}
			/>
			<Dialog
				open={creating === "bot"}
				onOpenChange={(open) => setCreating(open ? "bot" : undefined)}
			>
				<NewAgentDialog
					podId={pod?.id}
					pods={podsToAddTo}
					onCreated={async (agent, chosen) => {
						setCreating(undefined);
						const home = pod ?? chosen;
						if (!home) return;
						await navigate(
							pod ? agentChatLink({ pod: home, agent }) : allAgentChatLink({ pod: home, agent }),
						);
					}}
				/>
			</Dialog>
			<Dialog
				open={creating === "pod"}
				onOpenChange={(open) => setCreating(open ? "pod" : undefined)}
			>
				<NewPodDialog
					onCreated={async (made) => {
						setCreating(undefined);
						await navigate(podLink(made));
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

/** A list row with what it needs resolved: the bot's pod, and whether you wrote the last message. */
export interface ConversationRowData extends ChatListItem {
	pod: Pod;
	/** The pod's bots, for the badge a row carries in All. */
	podBots: readonly Agent[];
	fromYou: boolean;
}

export function ConversationListView({
	title,
	inAll,
	rows,
	status,
	selectedAgentId,
	onNewBot,
	emptyState,
	className,
}: {
	title: string;
	inAll: boolean;
	rows: readonly ConversationRowData[];
	status: "loading" | "ready" | "failed";
	selectedAgentId?: string;
	/** Absent when the viewer may not make a bot here. */
	onNewBot?: () => void;
	emptyState: EmptyList;
	className?: string;
}) {
	const [query, setQuery] = useState("");
	const needle = query.trim().toLowerCase();
	const shown = needle ? rows.filter((row) => row.agent.name.toLowerCase().includes(needle)) : rows;
	const empty = status === "ready" && rows.length === 0;

	return (
		<section
			aria-label={title}
			className={cn(
				"flex min-h-0 w-full shrink-0 flex-col border-border border-r bg-list md:w-[280px] lg:w-80",
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
								<ConversationRow
									row={row}
									inAll={inAll}
									selected={row.agent.id === selectedAgentId}
								/>
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
	inAll,
	selected,
}: {
	row: ConversationRowData;
	inAll: boolean;
	selected: boolean;
}) {
	const { agent, pod, lastMessage } = row;
	const link = inAll ? allAgentChatLink({ pod, agent }) : agentChatLink({ pod, agent });

	return (
		<Link
			{...link}
			aria-current={selected ? "page" : undefined}
			className={cn(
				"focus-ring flex items-center gap-3 rounded-[14px] px-2.5 py-[9px] transition-colors",
				selected ? "bg-row-selected" : "hover:bg-row-hover",
			)}
		>
			<span className="relative size-11 shrink-0">
				<AgentAvatar color={agent.color} face={agent.face} size={44} />
				{inAll && (
					<span className="absolute -right-[5px] -bottom-[5px]" title={pod.name}>
						<PodTile bots={row.podBots} size={20} className="border-[2.5px] border-list" />
					</span>
				)}
			</span>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="flex items-baseline gap-2">
					<span className="min-w-0 flex-1 truncate font-semibold text-[14.5px] text-foreground">
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
				<span className="truncate text-md text-muted-foreground">
					{lastMessage ? `${row.fromYou ? "You: " : ""}${lastMessage.preview}` : "No messages yet"}
				</span>
			</span>
		</Link>
	);
}

function crewOf(agents: readonly Agent[] | undefined, pod: Pod): Agent[] {
	return agents?.filter((agent) => agent.podId === pod.id && agent.systemAgentKey === null) ?? [];
}
