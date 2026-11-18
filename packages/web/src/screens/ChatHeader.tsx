import type { Bot, Channel, PersonParticipant } from "@sugabots/contracts";
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
import { useModelName } from "@/lib/bots.ts";
import { useAttentionCounts } from "@/lib/chats.ts";
import { botLink, channelLink, directMessagesLink, inboxLink } from "@/lib/links.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import { useSession } from "@/lib/session.ts";
import { useSidebarHiddenBesideChat } from "@/lib/sidebar-hidden.tsx";
import { BotAvatar } from "@/shell/Bot.tsx";
import { BotCrumb, CrumbSeparator } from "@/shell/BotCrumb.tsx";
import { InboxNews } from "@/shell/InboxNews.tsx";
import { StageBack, type StageParent } from "@/shell/Stage.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { BACK_BUTTON, BackChevron, isPlainClick, useLeave } from "@/ui/back-button.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { FLOATING_ON_PHONE, IconButton } from "@/ui/icon-button.tsx";
import { ChatComputer } from "./ComputerButton.tsx";
import { ComputerSheet } from "./ComputerSheet.tsx";
import { CHAT_HEADER_CONTAINER } from "./HeaderButton.tsx";
import { ParticipantFaces } from "./ParticipantFaces.tsx";

/** Where a page's Back on a phone returns to: the list it covers, or for a conversation, where it lives. */
export type BackTo =
	| { to: "channel"; channel: Channel }
	| { to: "inbox" }
	/** A task goes back to its bot. */
	| { to: "bot"; bot: Bot }
	/** A direct message goes back to the list of them. */
	| { to: "directMessages" };

/**
 * Where a chat is shown. On its own page it has Details, opened and closed
 * from its header. Shown elsewhere, as Inbox shows one, it has none: its
 * header has a Back to where it was opened from, and a way to the chat itself.
 */
export type ChatPlace =
	| {
			kind: "own";
			detailsOpen: boolean;
			onDetailsChange: (open: boolean) => void;
			/** At the right of the header, such as a stage's Close. */
			trailing?: ReactNode;
			/** The level the chat was opened from inside a stage, which its header's Back returns to. */
			parent?: StageParent;
	  }
	| { kind: "away"; back: BackTo; trailing: ReactNode };

/** What a chat's header does around its title: where Back goes, what is at its right, and its Details. */
export interface HeaderPlace {
	/** The list the chat covers on a phone, which Back returns to. */
	back: BackTo;
	/** At the right of the header, such as the way to the chat itself when shown elsewhere. */
	trailing?: ReactNode;
	/** Whether its Details are open, and what opens or closes them; absent where it has none. */
	details?: DetailsToggle;
	/** The level the chat was opened from inside a stage, which its Back returns to in place of `back`. */
	parent?: StageParent;
}

/** Whether a chat's Details are open, and what opens or closes them. */
interface DetailsToggle {
	open: boolean;
	onChange: (open: boolean) => void;
}

/**
 * The bar across the top of a bot's task: a breadcrumb of the bot and the
 * task's title, the faces of the people in it once there is more than one,
 * Mark done, and, with `details`, the way into its Details: the cards button,
 * or the title, which is how a phone reaches them. A phone also has the way
 * into the bot's computer, which from a tablet up is a card in Details.
 */
export function ChatHeader({
	bot,
	overChat = true,
	title,
	done,
	people = [],
	conversationId,
	onOpenDesktop,
	back,
	trailing,
	details,
}: HeaderPlace & {
	bot: Bot;
	/** Over the task, which scrolls up under it, rather than a bar of its own above it. */
	overChat?: boolean;
	/** The task's title, shown in place of the bot's name once it is loaded. */
	title?: string;
	/** Whether the task is done, and how to mark it done or reopen it. */
	done?: DoneToggle;
	/** The people in the task, whose faces show beside Mark done once there is more than one. */
	people?: readonly PersonParticipant[];
	conversationId: string;
	onOpenDesktop: () => void;
}) {
	const name = title ?? bot.name;
	const modelName = useModelName(bot.model);
	const openDetails = details && (() => details.onChange(!details.open));
	// A phone shows the computer in a sheet first, from which it opens full screen.
	const phone = !useMediaQuery(SIDE_BY_SIDE);
	const [computerOpen, setComputerOpen] = useState(false);
	const openComputer = phone ? () => setComputerOpen(true) : onOpenDesktop;
	return (
		<HeaderBar
			back={back}
			plain={overChat}
			badge={
				title === undefined ? (
					<FaceBadge
						face={
							<BotAvatar
								color={bot.color}
								face={bot.face}
								shape={bot.shape}
								size={PHONE_FACE_SIZE_PX}
							/>
						}
						name={bot.name}
						detail={modelName ?? undefined}
						onClick={openDetails}
					/>
				) : (
					<TitleBadge
						title={title}
						within={modelName ? `${bot.name} · ${modelName}` : bot.name}
						onClick={openDetails}
					/>
				)
			}
		>
			{/*
			 * A breadcrumb: the bot, which leads to its page, then the task's
			 * title, "Growth Desk / Fernhill pricing". Whose task it is, once here
			 * rather than over each message.
			 */}
			<div className="flex min-w-0 flex-1 items-center max-md:sr-only">
				<div data-header-title className="flex min-w-0 items-center gap-1.5">
					{title !== undefined && (
						<>
							<BotCrumb bot={bot} />
							<CrumbSeparator />
						</>
					)}
					<h1 className="m-0 flex min-w-0 items-center gap-1.5 font-medium text-foreground text-sm">
						{title === undefined && <BotFace bot={bot} />}
						{details ? (
							<button
								type="button"
								onClick={() => details.onChange(!details.open)}
								className="focus-ring block min-w-0 truncate rounded-md text-left"
							>
								{name}
							</button>
						) : (
							<span className="min-w-0 truncate">{name}</span>
						)}
					</h1>
				</div>
			</div>
			{/*
			 * From a tablet up the computer is a card in Details, and automations
			 * are in the bot's sidebar; a phone has room for one control beside a
			 * task's title, which holds the computer and done.
			 */}
			{done ? (
				<ConversationMenu done={done} back={back} onOpenDesktop={openComputer} />
			) : (
				<span className="contents md:hidden">
					<ChatComputer bot={bot} conversationId={conversationId} onOpen={openComputer} />
				</span>
			)}
			{people.length > 1 && <PeopleInTask people={people} />}
			{done && (
				<span className="contents max-md:hidden">
					<DoneButton {...done} />
				</span>
			)}
			{details && <DetailsButton {...details} cards />}
			{trailing}
			<Dialog open={computerOpen} onOpenChange={setComputerOpen}>
				<ComputerSheet
					bot={bot}
					conversationId={conversationId}
					onDismiss={() => setComputerOpen(false)}
					onOpenFull={() => {
						setComputerOpen(false);
						onOpenDesktop();
					}}
				/>
			</Dialog>
		</HeaderBar>
	);
}

/** On a phone, the ⋯ beside a task's title: its bot's computer, and marking it done or reopening it. */
function ConversationMenu({
	done,
	back,
	onOpenDesktop,
}: {
	done: DoneToggle;
	/** Where the task is left for once it is done. */
	back: BackTo;
	onOpenDesktop: () => void;
}) {
	const place = useBackPlace(back);
	// Done with, it is left as Back leaves it, rather than stayed in; once saved, so a failure
	// is seen on the task it was for.
	const markDone = async () => {
		if (await done.onChange(true)) place.leave();
	};
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<IconButton
						label="More for this task"
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
	"m-0 min-w-0 flex-1 truncate font-medium text-sm text-foreground max-md:sr-only";

/** How big a chat's face is beside its name in a phone's header, in pixels. */
export const PHONE_FACE_SIZE_PX = 32;

/**
 * The bar across the top of a chat: the same height and inset as a page's.
 * On a phone each piece floats on its own glass: Back at its left, then
 * `badge` saying whose chat it is, and its controls at its right, with the
 * messages scrolling under them faded out above them.
 */
function HeaderBar({
	back,
	parent,
	plain = false,
	badge,
	children,
}: {
	back: BackTo;
	parent?: StageParent;
	/** Without the rule under it, as a bot's task has it, its messages running up to it. */
	plain?: boolean;
	/** What a phone shows after Back: a `FaceBadge` or a `TitleBadge`. */
	badge: ReactNode;
	children: ReactNode;
}) {
	// Clear of the button that brings the sidebar back, which sits in the corner over the chat.
	const sidebarHidden = useSidebarHiddenBesideChat();
	return (
		<header
			className={cn(
				CHAT_HEADER_CONTAINER,
				// Over a bot's task, which scrolls up under it: no bar of its own.
				plain ? "md:border-b-0 md:bg-transparent" : "border-border border-b",
				sidebarHidden ? "md:pl-14" : "md:pl-6",
				"relative flex h-13 shrink-0 items-center gap-3 pr-4 transition-all duration-300 ease-out max-md:h-auto max-md:border-b-0 max-md:bg-linear-to-b max-md:from-background max-md:from-80% max-md:to-transparent max-md:px-4 max-md:pt-safe-or-3 max-md:pb-2",
			)}
		>
			{parent ? (
				<StageBack parent={parent} />
			) : (
				<div className="flex shrink-0 md:hidden">
					<HeaderBack back={back} />
				</div>
			)}
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
				<span className="max-w-full truncate font-semibold text-base text-foreground">{name}</span>
				{detail && (
					<span className="max-w-full truncate text-xs text-muted-foreground">{detail}</span>
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
			className="grid shrink-0 place-items-center rounded-xl bg-chip text-soft-foreground"
			style={{ width: PHONE_FACE_SIZE_PX, height: PHONE_FACE_SIZE_PX }}
		>
			{mark === "automation" ? (
				<RefreshCcw size={16} strokeWidth={2} />
			) : (
				<Hash size={18} strokeWidth={2} />
			)}
		</span>
	);
}

/** What a chat with no bot's face is marked with: a channel's #, or an automation's ↻. */
type ChatMark = "channel" | "automation";

/**
 * A task's or thread's name in a phone's header: its title, and under it where it is,
 * a bot or a channel, each cut short to the room the header leaves.
 */
function TitleBadge({
	title,
	within,
	onClick,
}: {
	title: string;
	/** What it is in or with, such as its bot. */
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
			<span className="max-w-full truncate font-semibold text-base leading-tight">{title}</span>
			{within && (
				<span className="max-w-full truncate text-xs text-muted-foreground leading-tight">
					in {within}
				</span>
			)}
		</button>
	);
}

/** A bot's small face beside its name in the bar. */
function BotFace({ bot }: { bot: Bot }) {
	return (
		<span aria-hidden className="flex shrink-0">
			<BotAvatar color={bot.color} face={bot.face} shape={bot.shape} size={14} />
		</span>
	);
}

/**
 * The people in a bot's task with more than one in it: their faces stacked,
 * which list them by name when clicked, the viewer among them as you.
 */
function PeopleInTask({ people }: { people: readonly PersonParticipant[] }) {
	const user = useSession().user;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<button
						type="button"
						aria-label={`${people.length} people in this task`}
						className="focus-ring flex h-8 items-center gap-1.5 rounded-md px-1.5 text-muted-foreground text-xs transition-colors hover:bg-row-hover hover:text-foreground data-popup-open:bg-row-selected max-md:hidden"
					>
						<ParticipantFaces participants={people} shown={3} size={20} />
					</button>
				}
			/>
			<DropdownMenuContent align="end" className="min-w-52">
				{people.map((person) => (
					<DropdownMenuItem key={person.id} closeOnClick={false}>
						<PersonAvatar person={person} size={20} />
						<span className="min-w-0 flex-1 truncate">
							{person.name}
							{person.id === user?.id && <span className="text-subtle-foreground"> (you)</span>}
						</span>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * The button that opens a chat's Details, or closes them: as a column beside
 * the chat, or, in a bot's task, as floating `cards`.
 */
function DetailsButton({ open, onChange, cards = false }: DetailsToggle & { cards?: boolean }) {
	return (
		<IconButton
			label="Details"
			variant="bar"
			aria-pressed={open}
			onClick={() => onChange(!open)}
			className={cn(HEADER_ICON_CLASS_NAME, "max-md:hidden")}
		>
			{cards ? <CardsIcon /> : <PanelRight size={16} strokeWidth={1.75} />}
		</IconButton>
	);
}

/** Two rows, each a dot and a line: the stack of Details cards. */
function CardsIcon() {
	return (
		<svg
			aria-hidden
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.75"
			strokeLinecap="round"
		>
			<circle cx="7" cy="8" r="2.5" />
			<path d="M13 8h7" />
			<circle cx="7" cy="16" r="2.5" />
			<path d="M13 16h7" />
		</svg>
	);
}

/**
 * The bar across the top of a chat with no bot's controls in it: between
 * people, a channel's main chat or thread, or an automation's feed.
 * What it is called, and its Details where it has them.
 */
export function PeopleChatHeader({
	title,
	menu,
	done,
	within,
	mark = "channel",
	face,
	detail,
	crumbs,
	back,
	parent,
	trailing,
	details,
}: HeaderPlace & {
	title: string;
	/** From a tablet up, where it sits, before its title as a breadcrumb: "Growth Desk / Automations". */
	crumbs?: ReactNode;
	/** What else can be done with it, at the end of the header. */
	menu?: ReactNode;
	/** Whether the task is done, and how to mark it done or reopen it; absent on a channel's conversation. */
	done?: DoneToggle;
	/** Where a task or thread is, such as its bot or channel, which a phone names under it. */
	within?: string;
	/** What a phone shows over the name of a chat that is not a task or thread. */
	mark?: ChatMark;
	/** Whose the chat is, as a face, such as a direct message's people, which a phone shows in place of `mark`. */
	face?: ReactNode;
	/** At the right of the title, before its Details, such as who is in a group direct message. */
	detail?: ReactNode;
}) {
	const openDetails = details && (() => details.onChange(!details.open));
	return (
		<HeaderBar
			back={back}
			parent={parent}
			badge={
				// A task can be marked done; a channel or an automation goes by its name.
				done ? (
					<TitleBadge title={title} within={within} onClick={openDetails} />
				) : (
					<FaceBadge
						face={face ?? <ChannelFace mark={mark} />}
						name={title}
						onClick={openDetails}
					/>
				)
			}
		>
			{crumbs && (
				<span className="flex min-w-0 shrink items-center gap-1.5 max-md:hidden">
					{crumbs}
					<CrumbSeparator />
				</span>
			)}
			<h1 className={TITLE_CLASS_NAME}>{title}</h1>
			{detail}
			{done && <DoneButton {...done} />}
			{details && <DetailsButton {...details} />}
			{menu}
			{trailing}
		</HeaderBar>
	);
}

/** Whether a task is done, and what marks it done or reopens it. */
export interface DoneToggle {
	isDone: boolean;
	/** Saves the change, resolving to whether it saved; a failure is shown where the task is. */
	onChange: (done: boolean) => Promise<boolean>;
}

/**
 * Marks the task done, which takes it off the sidebar once it is left, or
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
const HEADER_ICON_CLASS_NAME = cn(
	"text-muted-foreground hover:text-foreground aria-pressed:bg-row-selected aria-pressed:text-foreground",
	FLOATING_ON_PHONE,
);

/**
 * The round Back a phone shows at the left of a page's header, to the list
 * the page covers, with what is new in Inbox beside its chevron.
 */
export function HeaderBack({ back }: { back: BackTo }) {
	const { unreadForYou, unreadInInbox } = useAttentionCounts();
	const { label: backLabel } = useLeave();
	const className = cn(BACK_BUTTON, "md:hidden", unreadInInbox > 0 && "px-2");
	const content = (
		<>
			<BackChevron />
			<InboxNews
				unreadForYou={unreadForYou}
				unreadInInbox={unreadInInbox}
				size="md"
				countClassName="h-5 min-w-5 text-xs"
			/>
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
		case "channel":
			return {
				href: router.buildLocation(channelLink(back.channel)).href,
				name: back.channel.name,
			};
		case "bot":
			return { href: router.buildLocation(botLink(back.bot)).href, name: back.bot.name };
		case "inbox":
			return { href: router.buildLocation(inboxLink()).href, name: "Inbox" };
		case "directMessages":
			return { href: router.buildLocation(directMessagesLink()).href, name: "Direct messages" };
	}
}
