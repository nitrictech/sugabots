import type { ActivityItem, Agent, Pod } from "@sugabots/contracts";
import { Link, linkOptions, useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { useState } from "react";
import { useAgents } from "@/lib/agents.ts";
import { useActivityFeed } from "@/lib/chats.ts";
import { matchesMedia, SIDE_BY_SIDE } from "@/lib/media.ts";
import { usePods } from "@/lib/pods.ts";
import {
	type ActivityState,
	collaborationText,
	RoutineTriggerIcon,
	routineText,
} from "@/screens/ChatActivityRow.tsx";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { ListColumn, ListTime } from "@/shell/ListColumn.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { PillTabs } from "@/ui/pill-tabs.tsx";

type TabId = "all" | "mentions" | "collaborations" | "routines";

/** The pills over the list, each showing the kinds of activity under it, or all of it. */
const TABS: readonly { id: TabId; label: string; kinds?: readonly ActivityItem["kind"][] }[] = [
	{ id: "all", label: "All" },
	{ id: "mentions", label: "Mentions", kinds: ["mention"] },
	{ id: "collaborations", label: "Collaborations", kinds: ["collaboration"] },
	{ id: "routines", label: "Routines", kinds: ["routine"] },
];

/** What a pill with nothing under it says. */
const EMPTY: Record<TabId, string> = {
	all: "Nothing new. You're all caught up.",
	mentions: "Nobody has mentioned you lately.",
	collaborations: "No collaborations lately.",
	routines: "No routines have run lately.",
};

/**
 * The column beside the rail for what is new across the workspace's chats,
 * newest first: messages that mention the person or that they have not read,
 * routine runs, and collaborations one bot opened with another. Each opens
 * beside the column: a message in its chat, which reads it, and a run or
 * collaboration as a page of its own.
 */
export function ActivityList({
	selectedItemId,
	className,
}: {
	/** The row whose item is open beside the column. */
	selectedItemId?: string;
	className?: string;
}) {
	const feed = useActivityFeed();
	const { data: pods } = usePods();
	const { agents } = useAgents();
	const [tab, setTab] = useState<TabId>("all");
	const items = feed.data?.items ?? [];
	const navigate = useNavigate();
	const shownUnder = (id: TabId) => {
		const kinds = TABS.find((candidate) => candidate.id === id)?.kinds;
		return kinds ? items.filter((item) => kinds.includes(item.kind)) : items;
	};
	const shown = shownUnder(tab);
	const placeOf = (item: ActivityItem) => {
		const pod = pods?.find((candidate) => candidate.id === item.podId);
		const chatAgent = agents?.find((candidate) => candidate.id === item.chatAgentId);
		return pod && chatAgent ? { pod, chatAgent } : undefined;
	};

	/** Shows a pill's items and, where its pane is beside the list, opens the first of them. */
	function choose(id: TabId) {
		setTab(id);
		const [first] = shownUnder(id);
		if (!first || !matchesMedia(SIDE_BY_SIDE)) return;
		const place = placeOf(first);
		if (place) void navigate(activityItemLink(first, place));
	}

	return (
		<ListColumn title="Activity" className={className}>
			<PillTabs label="Show" tabs={TABS} selected={tab} onSelect={choose} />
			<ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-px overflow-y-auto px-2 pb-3">
				{feed.isError && (
					<li className="px-2.5 py-3 text-muted-foreground">Activity could not be loaded.</li>
				)}
				{feed.isSuccess && shown.length === 0 && (
					<li className="px-2.5 py-3 text-md text-muted-foreground">{EMPTY[tab]}</li>
				)}
				{shown.map((item) => (
					<li key={itemIdOf(item)}>
						<ActivityRow
							item={item}
							place={placeOf(item)}
							selected={itemIdOf(item) === selectedItemId}
						/>
					</li>
				))}
			</ul>
		</ListColumn>
	);
}

/** How a routine run's state reads in its row, as its line in the chat says it. */
function runState(state: Extract<ActivityItem, { kind: "routine" }>["state"]): ActivityState {
	if (state === "completed") return "done";
	if (state === "failed" || state === "cancelled") return "failed";
	return "running";
}

/** How a collaboration's status reads in its row, as its line in the chat says it. */
function collaborationState(
	status: Extract<ActivityItem, { kind: "collaboration" }>["status"],
): ActivityState {
	switch (status) {
		case "waiting":
			return "running";
		case "pending":
			return "waiting_on_you";
		case "answered":
			return "done";
		default:
			return "failed";
	}
}

/** What a row says happened, and the line under it. */
function wordsOf(item: ActivityItem): { title: string; detail: string } {
	switch (item.kind) {
		case "mention":
			return { title: `${item.author.name} mentioned you`, detail: item.preview };
		case "message":
			return {
				title:
					item.author.kind === "agent"
						? `${item.author.name} replied`
						: `${item.author.name} wrote`,
				detail: item.preview,
			};
		case "routine":
			return {
				title: routineText(item.routineName, runState(item.state)),
				detail: item.preview ?? item.agent.name,
			};
		case "collaboration":
			return {
				title: collaborationText(
					item.initiator.name,
					item.recipient.name,
					collaborationState(item.status),
				),
				detail: item.brief,
			};
	}
}

/** Who or what a row is about, in its face's place. */
function FaceOf({ item }: { item: ActivityItem }) {
	switch (item.kind) {
		case "routine":
			// The bot that ran it, with what started the run on its corner.
			return (
				<span className="relative size-[22px]">
					<AgentAvatar color={item.agent.color} face={item.agent.face} size={22} />
					<span className="absolute -right-1 -bottom-1 grid size-3.5 place-items-center rounded-full bg-chip text-soft-foreground shadow-[0_0_0_2px_var(--list)]">
						<RoutineTriggerIcon kind={item.triggerKind} size={9} strokeWidth={2.6} />
					</span>
				</span>
			);
		case "collaboration":
			return (
				<span className="relative h-[22px] w-[34px]">
					<AgentAvatar
						color={item.initiator.color}
						face={item.initiator.face}
						size={22}
						className="absolute top-0 left-0"
					/>
					<AgentAvatar
						color={item.recipient.color}
						face={item.recipient.face}
						size={22}
						className="absolute top-0 left-3 rounded-full shadow-[0_0_0_2px_var(--list)]"
					/>
				</span>
			);
		default:
			return item.author.kind === "agent" ? (
				<AgentAvatar color={item.author.color} face={item.author.face} size={22} />
			) : (
				<PersonAvatar person={item.author} size={22} />
			);
	}
}

/** The id a row is chosen by: its message's, or its run's or collaboration's thread's. */
function itemIdOf(item: ActivityItem): string {
	return item.kind === "routine" || item.kind === "collaboration" ? item.threadId : item.messageId;
}

/**
 * Where a row opens, beside the list: a run or collaboration as a page of its
 * own, and a message in its chat, jumped to. Either way the row is marked.
 */
function activityItemLink(item: ActivityItem, { pod, chatAgent }: ItemPlace) {
	return linkOptions({
		from: "/$workspace",
		to: "./activity/$pod/$agent",
		params: { pod: pod.slug, agent: chatAgent.handle },
		search:
			item.kind === "routine" || item.kind === "collaboration"
				? { item: item.threadId, threadPage: item.threadId }
				: { item: item.messageId, message: item.messageId },
	});
}

/** The pod and the bot whose chat an item is in. */
interface ItemPlace {
	pod: Pod;
	chatAgent: Agent;
}

/** One thing that happened: what and when, a line about it, and where it opens. */
function ActivityRow({
	item,
	place,
	selected,
}: {
	item: ActivityItem;
	/** Unknown while the pods and bots load, when the row cannot open yet. */
	place: ItemPlace | undefined;
	selected: boolean;
}) {
	const { title, detail } = wordsOf(item);
	const content = (
		<>
			<span aria-hidden className="mt-px flex shrink-0">
				<FaceOf item={item} />
			</span>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="flex items-baseline gap-2">
					<span
						className={cn(
							"min-w-0 flex-1 truncate text-[13.5px]",
							item.unread ? "font-semibold text-foreground" : "font-medium text-muted-foreground",
						)}
					>
						{title}
					</span>
					<ListTime at={item.at} selected={selected} />
				</span>
				<span className="line-clamp-2 text-[12.5px] text-muted-foreground leading-[1.4]">
					{detail}
				</span>
				{item.unread && <span className="sr-only">Unread</span>}
			</span>
		</>
	);
	const layout = "flex gap-2.5 rounded-tail px-2.5 py-2";
	if (!place) return <div className={layout}>{content}</div>;
	return (
		<Link
			{...activityItemLink(item, place)}
			aria-current={selected ? "page" : undefined}
			className={cn(
				layout,
				"focus-ring transition-colors",
				selected ? "bg-row-selected" : "hover:bg-row-hover",
			)}
		>
			{content}
		</Link>
	);
}
