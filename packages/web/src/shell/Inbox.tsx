import type { ActivityItem, Pod } from "@sugabots/contracts";
import { Link, linkOptions, useParams, useSearch } from "@tanstack/react-router";
import { cn } from "cn";
import { CheckCheck, Inbox as InboxIcon, ListFilter } from "lucide-react";
import { type CSSProperties, type ReactNode, useRef, useState } from "react";
import { useActivityFeed, useAttentionCounts, useMarkChatsRead } from "@/lib/chats.ts";
import { activityThreadLink } from "@/lib/links.ts";
import { countOf } from "@/lib/name-list.ts";
import { LIST_MIN_WIDTH_PX, usePaneWidth } from "@/lib/pane-width.ts";
import { usePods } from "@/lib/pods.ts";
import {
	type ActivityState,
	collaborationText,
	RoutineTriggerIcon,
	routineText,
} from "@/screens/ChatActivityRow.tsx";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { ListTime, PageHeader } from "@/shell/Page.tsx";
import { PodInitial } from "@/shell/SidebarPod.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { ResizeHandle } from "@/ui/resize-handle.tsx";

/** A kind of item in the feed, which the filter can narrow Inbox to. */
type Kind = ActivityItem["kind"];

const KINDS: readonly { value: Kind; label: string }[] = [
	{ value: "mention", label: "Mentions" },
	{ value: "message", label: "Messages" },
	{ value: "routine", label: "Routines" },
	{ value: "collaboration", label: "Collaborations" },
];

/**
 * Inbox: what is new across the workspace's chats, newest first, down the
 * left: messages that mention the person or that they have not read, routine
 * runs, and collaborations one bot opened with another. A filter menu in its
 * header narrows it to the kinds ticked there, shaded while on, and a toggle beside it shows only what is unread, as it
 * does to begin with; Mark all as read reads everything unread at
 * once. The one chosen opens beside it as `children`: a message in its chat,
 * which reads it, or a run or collaboration as a page of its own. On a phone
 * the list is the page until one is chosen.
 */
export function Inbox({ children }: { children: ReactNode }) {
	const feed = useActivityFeed();
	const { data: pods } = usePods();
	const chosen = useChosenItem();
	// As wide as the viewer last dragged it.
	const [width, setWidth] = usePaneWidth("inbox");
	const list = useRef<HTMLElement>(null);
	// The kinds the filter narrows Inbox to; with none, it lists every kind.
	const [kinds, setKinds] = useState<ReadonlySet<Kind>>(new Set());
	const [unreadOnly, setUnreadOnly] = useState(true);
	const inView = (feed.data?.items ?? []).filter((item) => !unreadOnly || item.unread);
	const items = inView.filter((item) => kinds.size === 0 || kinds.has(item.kind));
	const counted = KINDS.map((option) => ({
		...option,
		count: inView.filter((item) => item.kind === option.value).length,
	}));
	const toggleKind = (kind: Kind) => {
		const next = new Set(kinds);
		if (!next.delete(kind)) next.add(kind);
		setKinds(next);
	};
	const podOf = (item: ActivityItem) => pods?.find((candidate) => candidate.id === item.podId);
	const markRead = useMarkChatsRead();
	// Each item is read as its conversation is, so marking those reads them all.
	const unreadConversationIds = [
		...new Set(
			(feed.data?.items ?? []).filter((item) => item.unread).map((item) => item.conversationId),
		),
	];

	return (
		<div className="flex min-h-0 min-w-0 flex-1">
			<section
				ref={list}
				aria-label="Inbox"
				style={
					width === undefined ? undefined : ({ "--list-width": `${width}px` } as CSSProperties)
				}
				className={cn(
					"relative flex min-h-0 flex-col border-border border-r max-md:flex-1 md:w-[clamp(280px,var(--list-width,380px),60%)] md:shrink-0",
					chosen && "max-md:hidden",
				)}
			>
				<ResizeHandle
					label="Resize the list"
					pane={list}
					edge="end"
					min={LIST_MIN_WIDTH_PX}
					onResize={setWidth}
				/>
				<PageHeader
					title="Inbox"
					actions={
						<>
							<IconButton
								label="Unread only"
								variant="bar"
								aria-pressed={unreadOnly}
								onClick={() => setUnreadOnly(!unreadOnly)}
								className="aria-pressed:bg-chip aria-pressed:text-foreground"
							>
								<UnreadOnlyIcon />
							</IconButton>
							<KindFilter kinds={counted} chosen={kinds} onToggle={toggleKind} />
							{unreadConversationIds.length > 0 && (
								<IconButton
									label="Mark all as read"
									variant="bar"
									disabled={markRead.isPending}
									onClick={() => markRead.mutate(unreadConversationIds)}
								>
									<CheckCheck size={16} strokeWidth={1.75} />
								</IconButton>
							)}
						</>
					}
				/>
				<ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-0.5 overflow-y-auto p-2">
					{feed.isError && (
						<li className="px-3 py-3 text-[13px] text-muted-foreground">
							Inbox could not be loaded.
						</li>
					)}
					{feed.isSuccess && items.length === 0 && (
						<li className="py-16 text-center text-[13px] text-subtle-foreground">
							{unreadOnly ? "You're all caught up." : "Nothing has happened here yet."}
						</li>
					)}
					{items.map((item) => (
						<li key={itemIdOf(item)}>
							<InboxRow item={item} pod={podOf(item)} selected={isChosen(item, chosen)} />
						</li>
					))}
				</ul>
			</section>
			<div className={cn("flex min-w-0 flex-1 flex-col", !chosen && "max-md:hidden")}>
				{children}
			</div>
		</div>
	);
}

/**
 * The ⧩ that narrows Inbox to the kinds of item ticked in its menu, each with
 * how many there are in the view. Several can be ticked; none lists them all.
 */
function KindFilter({
	kinds,
	chosen,
	onToggle,
}: {
	kinds: readonly { value: Kind; label: string; count: number }[];
	chosen: ReadonlySet<Kind>;
	onToggle: (kind: Kind) => void;
}) {
	return (
		<DropdownMenu>
			<IconButton
				label="Filter"
				variant="bar"
				render={<DropdownMenuTrigger />}
				className={cn(chosen.size > 0 && "bg-chip text-foreground")}
			>
				<ListFilter size={16} strokeWidth={1.75} />
			</IconButton>
			<DropdownMenuContent align="start" className="min-w-48">
				{kinds.map((option) => (
					<DropdownMenuCheckboxItem
						key={option.value}
						className="min-h-8 py-1.5 text-[13px]"
						checked={chosen.has(option.value)}
						onCheckedChange={() => onToggle(option.value)}
					>
						<span className="flex-1">{option.label}</span>
						{option.count > 0 && (
							<span className="text-subtle-foreground text-xs tabular-nums">{option.count}</span>
						)}
					</DropdownMenuCheckboxItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** An inbox tray with a dot at its corner: only what is unread. */
function UnreadOnlyIcon() {
	return (
		<svg
			aria-hidden
			width={16}
			height={16}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.75}
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M22 12h-6l-2 3h-4l-2-3H2" />
			<path d="M14 4H7.24a2 2 0 0 0-1.79 1.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-1.4-2.8" />
			<circle cx="19.5" cy="4.5" r="2.5" fill="currentColor" stroke="none" />
		</svg>
	);
}

/** Beside Inbox while nothing is chosen: how much is unread. */
export function InboxOverview() {
	const { unreadInInbox } = useAttentionCounts();
	return (
		<div className="flex h-full pb-[10%]">
			<EmptyState
				icon={<InboxIcon strokeWidth={1.75} />}
				title={
					unreadInInbox > 0
						? countOf(unreadInInbox, "unread item", "unread items")
						: "You're all caught up"
				}
			>
				Choose something on the left to open it here.
			</EmptyState>
		</div>
	);
}

/** The item open beside Inbox, as the address names it, if one is. */
interface ChosenItem {
	conversationId: string;
	/** The message jumped to, for a message. */
	messageId?: string;
	/** The run or collaboration shown, for one of those. */
	threadPageId?: string;
}

function useChosenItem(): ChosenItem | undefined {
	const { conversation } = useParams({ strict: false });
	const search = useSearch({ strict: false });
	if (!conversation) return undefined;
	return {
		conversationId: conversation,
		messageId: search.message,
		threadPageId: search.threadPage,
	};
}

function isChosen(item: ActivityItem, chosen: ChosenItem | undefined): boolean {
	if (!chosen || item.conversationId !== chosen.conversationId) return false;
	return item.kind === "routine" || item.kind === "collaboration"
		? item.threadId === chosen.threadPageId
		: item.messageId === chosen.messageId;
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
				<span className="relative size-6">
					<AgentAvatar
						color={item.agent.color}
						face={item.agent.face}
						shape={item.agent.shape}
						size={24}
					/>
					<span className="absolute -right-1.5 -bottom-1.5 grid size-4 place-items-center rounded-full bg-chip-strong text-foreground shadow-[0_0_0_2px_var(--background)]">
						<RoutineTriggerIcon kind={item.triggerKind} size={11} strokeWidth={2.4} />
					</span>
				</span>
			);
		case "collaboration":
			return (
				<span className="relative h-6 w-9">
					<AgentAvatar
						color={item.initiator.color}
						face={item.initiator.face}
						shape={item.initiator.shape}
						size={24}
						className="absolute top-0 left-0"
					/>
					<AgentAvatar
						color={item.recipient.color}
						face={item.recipient.face}
						shape={item.recipient.shape}
						size={24}
						ringed={{ color: "var(--background)", width: 2 }}
						className="absolute top-0 left-3"
					/>
				</span>
			);
		default:
			return item.author.kind === "agent" ? (
				<AgentAvatar
					color={item.author.color}
					face={item.author.face}
					shape={item.author.shape}
					size={24}
				/>
			) : (
				<PersonAvatar person={item.author} size={24} />
			);
	}
}

/** The id a row is chosen by: its message's, or its run's or collaboration's thread's. */
function itemIdOf(item: ActivityItem): string {
	return item.kind === "routine" || item.kind === "collaboration" ? item.threadId : item.messageId;
}

/**
 * Where a row opens: a run or collaboration as a page of its own, and a
 * message in its conversation, jumped to. `pod` is the pod the item is in.
 */
function activityItemLink(item: ActivityItem, pod: Pod) {
	const place = { pod, conversationId: item.conversationId };
	if (item.kind === "routine" || item.kind === "collaboration") {
		return activityThreadLink(place, item.threadId);
	}
	return linkOptions({
		from: "/$workspace",
		to: "./activity/$pod/$conversation",
		params: { pod: pod.slug, conversation: item.conversationId },
		search: { message: item.messageId },
	});
}

/**
 * One thing that happened: a dot while it is unread, who or what it is about,
 * what happened and its pod's mark, and under them a line about it and when,
 * shaded while it is open.
 */
function InboxRow({
	item,
	pod,
	selected,
}: {
	item: ActivityItem;
	/** The pod the item is in, once the pods are loaded; until then the row cannot open. */
	pod: Pod | undefined;
	/** Whether it is the one open beside the list. */
	selected: boolean;
}) {
	const { title, detail } = wordsOf(item);
	const content = (
		<>
			<span className="w-1.5 shrink-0 pt-[7px]">
				{item.unread && (
					<span className="block size-1.5 rounded-full bg-foreground">
						<span className="sr-only">Unread</span>
					</span>
				)}
			</span>
			<span aria-hidden className="flex shrink-0">
				<FaceOf item={item} />
			</span>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="flex min-w-0 items-center gap-2">
					<span
						className={cn(
							"min-w-0 flex-1 truncate text-[13px]",
							item.unread ? "font-semibold text-foreground" : "text-muted-foreground",
						)}
					>
						{title}
					</span>
					{pod && (
						<span title={pod.name} className="flex">
							<PodInitial pod={pod} size="sm" />
							<span className="sr-only">in {pod.name}</span>
						</span>
					)}
				</span>
				<span className="flex min-w-0 items-baseline gap-2">
					<span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
						{detail}
					</span>
					<ListTime at={item.at} />
				</span>
			</span>
		</>
	);
	const layout = "flex gap-3 rounded-lg p-2.5";
	if (!pod) return <div className={layout}>{content}</div>;
	return (
		<Link
			{...activityItemLink(item, pod)}
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
