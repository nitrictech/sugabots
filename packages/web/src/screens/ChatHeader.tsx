import type { Agent, Pod } from "@sugabots/contracts";
import { useRouter } from "@tanstack/react-router";
import { cn } from "cn";
import {
	CircleCheck,
	Ellipsis,
	Hash,
	Monitor,
	PanelRight,
	RefreshCcw,
	RotateCcw,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { useModelName } from "@/lib/agents.ts";
import { useAttentionCounts } from "@/lib/chats.ts";
import { activityLink, agentChatLink, conversationLink, podLink } from "@/lib/links.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import { usePods } from "@/lib/pods.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { BACK_BUTTON, BackChevron, isPlainClick, useLeave } from "@/ui/back-button.tsx";
import { CountBadge } from "@/ui/count-badge.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { FLOATING_ON_PHONE, IconButton } from "@/ui/icon-button.tsx";
import { ComputerSheet } from "./ComputerSheet.tsx";
import { ChatSandbox } from "./SandboxButton.tsx";

/** Where a page's Back on a phone returns to: the list it covers, or for a thread, where the thread lives. */
export type BackTo =
	| { to: "pod"; pod: Pod }
	| { to: "activity" }
	/** A thread with a bot goes back to the bot's chat. */
	| { to: "bot"; pod: Pod; agent: Agent }
	/** A thread started from one of a pod's channels goes back to it. */
	| { to: "channel"; pod: Pod; conversationId: string; name: string };

/**
 * Where a chat is shown. On its own page it has Details, opened and closed
 * from its header. Shown elsewhere, as Activity shows one, it has none: its
 * header has a Back to where it was opened from, and a way to the chat itself.
 */
export type ChatPlace =
	| { kind: "own"; detailsOpen: boolean; onDetailsChange: (open: boolean) => void }
	| { kind: "away"; back: BackTo; trailing: ReactNode };

/** What a chat's header does around its title: where Back goes, what is at its right, and its Details. */
export interface HeaderPlace {
	/** The list the chat covers on a phone, which Back returns to. */
	back: BackTo;
	/** At the right of the header, such as the way to the chat itself when shown elsewhere. */
	trailing?: ReactNode;
	/** Whether its Details are open, and what opens or closes them; absent where it has none. */
	details?: DetailsToggle;
}

/** Whether a chat's Details are open, and what opens or closes them. */
export interface DetailsToggle {
	open: boolean;
	onChange: (open: boolean) => void;
}

/**
 * The bar across the top of a bot's chat: its name, the way into its
 * sandbox's desktop when it has one, and, with `details`, the way into its
 * Details: the ⓘ, or the name, which is how a phone reaches them.
 */
export function ChatHeader({
	agent,
	title,
	done,
	conversationId,
	onOpenDesktop,
	back,
	trailing,
	details,
}: HeaderPlace & {
	agent: Agent;
	/** The thread's title, shown in place of the bot's name once it is loaded. */
	title?: string;
	/** Whether the thread is done, and how to mark it done or reopen it. */
	done?: DoneToggle;
	conversationId: string;
	onOpenDesktop: () => void;
}) {
	const name = title ?? agent.name;
	const modelName = useModelName(agent.model);
	const openDetails = details && (() => details.onChange(!details.open));
	// A phone shows the computer in a sheet first, from which it opens full screen.
	const phone = !useMediaQuery(SIDE_BY_SIDE);
	const pod = usePods().data?.find((candidate) => candidate.id === agent.podId);
	const [computerOpen, setComputerOpen] = useState(false);
	const openComputer = phone && pod ? () => setComputerOpen(true) : onOpenDesktop;
	return (
		<HeaderBar
			back={back}
			badge={
				title === undefined ? (
					<FaceBadge
						face={
							<AgentAvatar
								color={agent.color}
								face={agent.face}
								shape={agent.shape}
								size={PHONE_FACE_SIZE_PX}
							/>
						}
						name={agent.name}
						detail={modelName ?? undefined}
						onClick={openDetails}
					/>
				) : (
					<ThreadBadge
						title={title}
						within={modelName ? `${agent.name} · ${modelName}` : agent.name}
						onClick={openDetails}
					/>
				)
			}
		>
			<div className="flex min-w-0 flex-1 items-baseline gap-2 max-md:sr-only">
				<h1 className="m-0 min-w-0 truncate font-medium text-[14px] text-foreground">
					{details ? (
						<button
							type="button"
							onClick={() => details.onChange(!details.open)}
							className="focus-ring block max-w-full truncate rounded-md text-left"
						>
							{name}
						</button>
					) : (
						name
					)}
				</h1>
				{modelName && (
					<span className="shrink-0 whitespace-nowrap text-[12.5px] text-muted-foreground">
						{modelName}
					</span>
				)}
			</div>
			{done ? (
				<>
					{/* A phone has room for one control beside a thread's title, which holds both. */}
					<span className="contents max-md:hidden">
						<ChatSandbox agent={agent} threadId={conversationId} onOpen={onOpenDesktop} />
						<DoneButton {...done} />
					</span>
					<ThreadMenu done={done} back={back} onOpenDesktop={openComputer} />
				</>
			) : (
				<ChatSandbox agent={agent} threadId={conversationId} onOpen={openComputer} />
			)}
			{details && <DetailsButton {...details} />}
			{trailing}
			{pod && (
				<Dialog open={computerOpen} onOpenChange={setComputerOpen}>
					<ComputerSheet
						agent={agent}
						pod={pod}
						threadId={conversationId}
						onDismiss={() => setComputerOpen(false)}
						onOpenFull={() => {
							setComputerOpen(false);
							onOpenDesktop();
						}}
					/>
				</Dialog>
			)}
		</HeaderBar>
	);
}

/** On a phone, the ⋯ beside a thread's title: its bot's computer, and marking it done or reopening it. */
function ThreadMenu({
	done,
	back,
	onOpenDesktop,
}: {
	done: DoneToggle;
	/** Where the thread is left for once it is done. */
	back: BackTo;
	onOpenDesktop: () => void;
}) {
	const place = useBackPlace(back);
	// Done with, it is left as Back leaves it, rather than stayed in; once saved, so a failure
	// is seen on the thread it was for.
	const markDone = async () => {
		if (await done.onChange(true)) place.leave();
	};
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<IconButton
						label="More for this thread"
						variant="bar"
						className={cn(FLOATING_ON_PHONE, "md:hidden")}
					>
						<Ellipsis size={18} strokeWidth={2} />
					</IconButton>
				}
			/>
			<DropdownMenuContent align="end" className="min-w-48">
				<DropdownMenuItem onClick={onOpenDesktop}>
					<Monitor aria-hidden size={16} />
					Computer
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={done.isDone ? () => void done.onChange(false) : () => void markDone()}
				>
					{done.isDone ? (
						<RotateCcw aria-hidden size={16} />
					) : (
						<CircleCheck aria-hidden size={16} />
					)}
					{done.isDone ? "Reopen" : "Mark done"}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * The title across the top of a chat, as a page's is: its name, in the same
 * type and place. A phone shows the header's badge in its place.
 */
const TITLE_CLASS_NAME =
	"m-0 min-w-0 flex-1 truncate font-medium text-[14px] text-foreground max-md:sr-only";

/** How big a chat's face is beside its name in a phone's header, in pixels. */
const PHONE_FACE_SIZE_PX = 32;

/**
 * The bar across the top of a chat: the same height and inset as a page's.
 * On a phone each piece floats on its own glass: Back at its left, then
 * `badge` saying whose chat it is, and its controls at its right, with the
 * messages scrolling under them faded out above them.
 */
function HeaderBar({
	back,
	badge,
	children,
}: {
	back: BackTo;
	/** What a phone shows after Back: a `FaceBadge` or a `ThreadBadge`. */
	badge: ReactNode;
	children: ReactNode;
}) {
	return (
		<header className="relative flex h-[52px] shrink-0 items-center gap-3 border-border border-b pr-4 pl-6 max-md:h-auto max-md:border-b-0 max-md:bg-linear-to-b max-md:from-background max-md:from-80% max-md:to-transparent max-md:px-4 max-md:pt-[max(12px,env(safe-area-inset-top))] max-md:pb-2">
			<div className="flex shrink-0 md:hidden">
				<HeaderBack back={back} />
			</div>
			<div className="flex min-w-0 flex-1 md:hidden">{badge}</div>
			<div className="contents max-md:flex max-md:shrink-0 max-md:items-center max-md:gap-2">
				{children}
			</div>
		</header>
	);
}

/**
 * Whose chat it is, in a phone's header: its face beside its name, and under
 * the name `detail`, such as a bot's model. It opens its Details where it has them.
 */
function FaceBadge({
	face,
	name,
	detail,
	onClick,
}: {
	face: ReactNode;
	name: string;
	detail?: string;
	onClick?: () => void;
}) {
	const content = (
		<>
			{face}
			<span className="flex min-w-0 flex-col items-start text-left leading-tight">
				<span className="max-w-full truncate font-semibold text-[16px] text-foreground">
					{name}
				</span>
				{detail && (
					<span className="max-w-full truncate text-[12px] text-muted-foreground">{detail}</span>
				)}
			</span>
		</>
	);
	const className =
		"glass flex h-11 min-w-0 max-w-full items-center gap-2 rounded-full pr-4 pl-1.5";
	return onClick ? (
		<button
			type="button"
			aria-hidden
			tabIndex={-1}
			onClick={onClick}
			className={cn(className, "focus-ring active:bg-hover-strong")}
		>
			{content}
		</button>
	) : (
		<span aria-hidden className={className}>
			{content}
		</span>
	);
}

/** A channel's mark in a phone's header: a # on a rounded square. */
function ChannelFace({ mark }: { mark: ChatMark }) {
	return (
		<span
			className="grid shrink-0 place-items-center rounded-[30%] bg-chip text-soft-foreground"
			style={{ width: PHONE_FACE_SIZE_PX, height: PHONE_FACE_SIZE_PX }}
		>
			{mark === "routine" ? (
				<RefreshCcw size={16} strokeWidth={2} />
			) : (
				<Hash size={18} strokeWidth={2} />
			)}
		</span>
	);
}

/** What a chat with no bot's face is marked with: a channel's #, or a routine's ↻. */
type ChatMark = "channel" | "routine";

/**
 * A thread's name in a phone's header: its title, and under it where it is,
 * a bot or a channel, each cut short to the room the header leaves.
 */
function ThreadBadge({
	title,
	within,
	onClick,
}: {
	title: string;
	/** What the thread is in or with, such as its bot. */
	within?: string;
	onClick?: () => void;
}) {
	return (
		<button
			type="button"
			aria-hidden
			tabIndex={-1}
			onClick={onClick}
			disabled={!onClick}
			className="glass flex h-11 min-w-0 max-w-full flex-col items-start justify-center rounded-full px-4 text-left text-foreground active:bg-hover-strong"
		>
			<span className="max-w-full truncate font-semibold text-[16px] leading-tight">{title}</span>
			{within && (
				<span className="max-w-full truncate text-[12px] text-muted-foreground leading-tight">
					in {within}
				</span>
			)}
		</button>
	);
}

/** The ⓘ that opens a chat's Details, or closes them. */
function DetailsButton({ open, onChange }: DetailsToggle) {
	return (
		<IconButton
			label="Details"
			variant="bar"
			aria-pressed={open}
			onClick={() => onChange(!open)}
			className={cn(HEADER_ICON_CLASS_NAME, "max-md:hidden")}
		>
			<PanelRight size={16} strokeWidth={1.75} />
		</IconButton>
	);
}

/**
 * The bar across the top of a chat with no bot's controls in it: between
 * people, the pod's chat, a thread started from it, or a routine's thread.
 * What it is called, and its Details where it has them.
 */
export function PeopleChatHeader({
	title,
	menu,
	done,
	within,
	mark = "channel",
	back,
	trailing,
	details,
}: HeaderPlace & {
	title: string;
	/** What else can be done with it, at the end of the header. */
	menu?: ReactNode;
	/** Whether the thread is done, and how to mark it done or reopen it; absent on the pod's chat. */
	done?: DoneToggle;
	/** Where a thread is, such as the channel it was started from, which a phone names under it. */
	within?: string;
	/** What a phone shows over the name of a chat that is not a thread. */
	mark?: ChatMark;
}) {
	const openDetails = details && (() => details.onChange(!details.open));
	return (
		<HeaderBar
			back={back}
			badge={
				// A thread can be marked done; a channel or a routine goes by its name.
				done ? (
					<ThreadBadge title={title} within={within} onClick={openDetails} />
				) : (
					<FaceBadge face={<ChannelFace mark={mark} />} name={title} onClick={openDetails} />
				)
			}
		>
			<h1 className={TITLE_CLASS_NAME}>{title}</h1>
			{done && <DoneButton {...done} />}
			{details && <DetailsButton {...details} />}
			{menu}
			{trailing}
		</HeaderBar>
	);
}

/** Whether a thread is done, and what marks it done or reopens it. */
export interface DoneToggle {
	isDone: boolean;
	/** Saves the change, resolving to whether it saved; a failure is shown where the thread is. */
	onChange: (done: boolean) => Promise<boolean>;
}

/**
 * Marks the thread done, which takes it off the sidebar once it is left, or
 * reopens it; its name, and tooltip, say which it will do.
 */
function DoneButton({ isDone, onChange }: DoneToggle) {
	return (
		<IconButton
			label={isDone ? "Reopen" : "Mark done"}
			variant="bar"
			onClick={() => void onChange(!isDone)}
			className={HEADER_ICON_CLASS_NAME}
		>
			{isDone ? (
				<RotateCcw size={16} strokeWidth={1.75} />
			) : (
				<CircleCheck size={16} strokeWidth={1.75} />
			)}
		</IconButton>
	);
}

/**
 * An icon button in a chat's header, quieter until pointed at, and shaded
 * while what it opens is open. On a phone, round on glass.
 */
export const HEADER_ICON_CLASS_NAME = cn(
	"text-muted-foreground hover:text-foreground aria-pressed:bg-row-selected aria-pressed:text-foreground",
	FLOATING_ON_PHONE,
);

/**
 * The round Back a phone shows at the left of a page's header, to the list
 * the page covers, with how much is unread in Inbox beside its chevron.
 */
export function HeaderBack({ back }: { back: BackTo }) {
	const { unreadInInbox } = useAttentionCounts();
	const { label: backLabel } = useLeave();
	const className = cn(BACK_BUTTON, "md:hidden", unreadInInbox > 0 && "px-2");
	const content = (
		<>
			<BackChevron />
			{unreadInInbox > 0 && (
				<CountBadge
					count={unreadInInbox}
					size="md"
					label={`${unreadInInbox} unread in Inbox`}
					className="h-5 min-w-5 text-[12px]"
				/>
			)}
		</>
	);
	const place = useBackPlace(back);
	return (
		<a
			href={place.href}
			aria-label={backLabel(place.name)}
			className={className}
			onClick={(event) => {
				if (!isPlainClick(event)) return;
				event.preventDefault();
				place.leave();
			}}
		>
			{content}
		</a>
	);
}

/**
 * Where `back` goes, by its address and name, and leaving for it as a phone's
 * Back does: to the page this one was opened from, or, when this page was
 * the first one opened, to `back` in this page's place, so its own Back does
 * not return here.
 */
function useBackPlace(back: BackTo) {
	const router = useRouter();
	const { leave } = useLeave();
	const { href, name } = backAddress(router, back);
	return {
		href,
		name,
		leave: () => leave(() => void router.navigate({ href, replace: true })),
	};
}

function backAddress(router: ReturnType<typeof useRouter>, back: BackTo) {
	switch (back.to) {
		case "pod":
			return { href: router.buildLocation(podLink(back.pod)).href, name: back.pod.name };
		case "bot":
			return {
				href: router.buildLocation(agentChatLink({ pod: back.pod, agent: back.agent })).href,
				name: back.agent.name,
			};
		case "channel":
			return {
				href: router.buildLocation(
					conversationLink({ pod: back.pod, conversationId: back.conversationId }),
				).href,
				name: back.name,
			};
		case "activity":
			return { href: router.buildLocation(activityLink()).href, name: "Inbox" };
	}
}
