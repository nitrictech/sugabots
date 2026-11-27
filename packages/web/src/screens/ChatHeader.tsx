import type { Bot, MemberParticipant, Project } from "@sugabots/contracts";
import { useRouter } from "@tanstack/react-router";
import { cn } from "cn";
import { CircleCheck, Monitor, PanelRight, RefreshCcw, RotateCcw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { botLink, projectLink } from "@/lib/links.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import { ownerLinkOptions, type ResourceOwner } from "@/lib/resource-owner.tsx";
import { useSession } from "@/lib/session.ts";
import { useSidebarHiddenBesideChat } from "@/lib/sidebar-hidden.tsx";
import { BotAvatar } from "@/shell/Bot.tsx";
import { BotCrumb, CrumbSeparator } from "@/shell/BotCrumb.tsx";
import { StageBack, type StageParent } from "@/shell/Stage.tsx";
import { MemberAvatar } from "@/ui/avatar.tsx";
import { BACK_BUTTON, BackChevron, isPlainClick, useLeave } from "@/ui/back-button.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { FLOATING_ON_PHONE, IconButton } from "@/ui/icon-button.tsx";
import { MoreMenu } from "@/ui/more-menu.tsx";
import { SpacedText } from "@/ui/spaced-text.tsx";
import { CHAT_HEADER_CONTAINER, ChatComputer } from "./ComputerButton.tsx";
import { ComputerSheet } from "./ComputerSheet.tsx";
import { ModelName } from "./ModelName.tsx";
import { ParticipantFaces } from "./ParticipantFaces.tsx";

/** Where a page's Back on a phone returns to: the list it covers, or for a chat, where it lives. */
export type BackTo =
	| { to: "project"; project: Project }
	/** A bot's chat goes back to its bot. */
	| { to: "bot"; bot: Bot }
	/** A page under a project's or a bot's Settings, such as a project's Members, goes back to them. */
	| { to: "ownerSettings"; owner: ResourceOwner };

/** Back to `owner`'s page: a project's, or a bot's. */
export function backToOwner(owner: ResourceOwner): BackTo {
	return "project" in owner
		? { to: "project", project: owner.project }
		: { to: "bot", bot: owner.bot };
}

/** Where a chat is shown: on its own page, with Details opened and closed from its header. */
export type ChatPlace = {
	kind: "own";
	detailsOpen: boolean;
	onDetailsChange: (open: boolean) => void;
	/** At the right of the header, such as a stage's Close. */
	trailing?: ReactNode;
	/** The level the chat was opened from inside a stage, which its header's Back returns to. */
	parent?: StageParent;
};

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
 * The bar across the top of a bot's chat: a breadcrumb of the bot and the
 * chat's title, the faces of the members taking part once there is more than one,
 * Resolve, and, with `details`, the way into its Details: the cards button,
 * or the title, which is how a phone reaches them. A phone also has the way
 * into the bot's computer, which from a tablet up is a card in Details.
 */
export function ChatHeader({
	bot,
	overChat,
	title,
	resolved,
	members = [],
	chatId,
	onOpenDesktop,
	back,
	trailing,
	details,
}: Omit<HeaderPlace, "parent"> & {
	bot: Bot;
	/** Over the chat, which scrolls up under it, rather than a bar of its own above it. */
	overChat: boolean;
	/** The chat's title, shown in place of the bot's name once it is loaded. */
	title?: string;
	/** Whether the chat is resolved, and how to mark it resolved or reopen it. */
	resolved?: ResolvedToggle;
	/** The members taking part in the chat, whose faces show beside Resolve once there is more than one. */
	members?: readonly MemberParticipant[];
	chatId: string;
	onOpenDesktop: () => void;
}) {
	const name = title ?? bot.name;
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
					<HeaderBadge
						face={
							<BotAvatar
								color={bot.color}
								eyes={bot.eyes}
								shape={bot.shape}
								size={PHONE_FACE_SIZE_PX}
							/>
						}
						title={bot.name}
						sub={bot.model ? <ModelName modelId={bot.model} /> : undefined}
						onClick={openDetails}
					/>
				) : (
					<HeaderBadge
						title={title}
						sub={
							<SpacedText
								parts={[`in ${bot.name}`, bot.model && <ModelName modelId={bot.model} />]}
							/>
						}
						onClick={openDetails}
					/>
				)
			}
		>
			{/*
			 * A breadcrumb: the bot, which leads to its page, then the chat's
			 * title, "Growth Desk / Fernhill pricing".
			 */}
			<h1 className="sr-only md:hidden">{name}</h1>
			<div className="hidden min-w-0 flex-1 items-center md:flex">
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
			 * chat's title, which holds the computer and Resolve.
			 */}
			{resolved?.onChange ? (
				<ChatMenu
					isResolved={resolved.isResolved}
					onChange={resolved.onChange}
					back={back}
					onOpenDesktop={openComputer}
				/>
			) : (
				<span className="contents md:hidden">
					<ChatComputer bot={bot} chatId={chatId} onOpen={openComputer} />
				</span>
			)}
			{members.length > 1 && <MembersInChat members={members} />}
			{resolved?.onChange && (
				<span className="contents max-md:hidden">
					<ResolveButton isResolved={resolved.isResolved} onChange={resolved.onChange} />
				</span>
			)}
			{details && <DetailsButton {...details} cards />}
			{trailing}
			<Dialog open={computerOpen} onOpenChange={setComputerOpen}>
				<ComputerSheet
					bot={bot}
					chatId={chatId}
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

/** On a phone, the ⋯ beside a chat's title: its bot's computer, and marking it resolved or reopening it. */
function ChatMenu({
	isResolved,
	onChange,
	back,
	onOpenDesktop,
}: Required<ResolvedToggle> & {
	/** Where the chat is left for once it is resolved. */
	back: BackTo;
	onOpenDesktop: () => void;
}) {
	const place = useBackPlace(back);
	// Resolved, it is left as Back leaves it, rather than stayed in; once saved, so a failure
	// is seen on the chat it was for.
	const markResolved = async () => {
		if (await onChange(true)) place.leave();
	};
	return (
		<MoreMenu label="More for this chat" variant="bar" className="md:hidden">
			<DropdownMenuItem onClick={onOpenDesktop}>
				<Monitor aria-hidden size={16} />
				Computer
			</DropdownMenuItem>
			<DropdownMenuItem
				onClick={isResolved ? () => void onChange(false) : () => void markResolved()}
			>
				{isResolved ? <RotateCcw aria-hidden size={16} /> : <CircleCheck aria-hidden size={16} />}
				{isResolved ? "Reopen" : "Resolve"}
			</DropdownMenuItem>
		</MoreMenu>
	);
}

/** How big a chat's face is beside its name in a phone's header, in pixels: `size-8`. */
const PHONE_FACE_SIZE_PX = 32;

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
	/** Without the rule under it, over the chat, its messages scrolling up under it out of sight. */
	plain?: boolean;
	/** What a phone shows after Back: a `HeaderBadge`. */
	badge: ReactNode;
	children: ReactNode;
}) {
	// Clear of the button that brings the sidebar back, which sits in the corner over the chat.
	const sidebarHidden = useSidebarHiddenBesideChat();
	return (
		<header
			className={cn(
				CHAT_HEADER_CONTAINER,
				// Over the chat, which scrolls up under it: a solid bar with no rule.
				plain ? "md:border-b-0 md:bg-background" : "border-border border-b",
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
 * Whose chat it is, in a phone's header, on a pill of glass: its face, if it
 * has one, beside its title, with `sub` under the title, such as a bot's model
 * or where a chat is, each cut short to the room the header leaves. It opens
 * the chat's Details where it has them.
 */
function HeaderBadge({
	face,
	title,
	sub,
	onClick,
}: {
	face?: ReactNode;
	title: string;
	sub?: ReactNode;
	onClick?: () => void;
}) {
	const content = (
		<>
			{face}
			<span className="flex min-w-0 flex-col items-start text-left leading-tight">
				<span className="max-w-full truncate font-semibold text-base text-foreground">{title}</span>
				{sub && <span className="max-w-full truncate text-xs text-muted-foreground">{sub}</span>}
			</span>
		</>
	);
	const className = cn(
		"glass flex h-11 min-w-0 max-w-full items-center gap-2 rounded-full pr-4",
		face ? "pl-1.5" : "pl-4",
	);
	return onClick ? (
		<button
			type="button"
			aria-label={`Details for ${title}`}
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

/** An automation's feed's mark in a phone's header: its ↻ on a rounded square. */
export function AutomationFace() {
	return (
		<span className="grid size-8 shrink-0 place-items-center rounded-xl bg-chip text-soft-foreground">
			<RefreshCcw size={16} strokeWidth={2} />
		</span>
	);
}

/** A bot's small face beside its name in the bar. */
function BotFace({ bot }: { bot: Bot }) {
	return (
		<span aria-hidden className="flex shrink-0">
			<BotAvatar color={bot.color} eyes={bot.eyes} shape={bot.shape} size={14} />
		</span>
	);
}

/**
 * The members taking part in a bot's chat with more than one: their faces stacked,
 * which list them by name when clicked, the viewer among them as you.
 */
function MembersInChat({ members }: { members: readonly MemberParticipant[] }) {
	const signedIn = useSession().member;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<button
						type="button"
						aria-label={`${members.length} members taking part in this chat`}
						className="focus-ring flex h-8 items-center gap-1.5 rounded-md px-1.5 text-muted-foreground text-xs transition-colors hover:bg-row-hover hover:text-foreground data-popup-open:bg-row-selected max-md:hidden"
					>
						<ParticipantFaces participants={members} shown={3} size={20} />
					</button>
				}
			/>
			<DropdownMenuContent align="end" className="min-w-52">
				{members.map((member) => (
					<DropdownMenuItem key={member.id} closeOnClick={false}>
						<MemberAvatar member={member} size={20} />
						<span className="min-w-0 flex-1 truncate">
							{member.name}
							{member.id === signedIn?.id && <span className="text-subtle-foreground"> (you)</span>}
						</span>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * The button that opens a chat's Details, or closes them: as a column beside
 * the chat, or, in a chat, as floating `cards`.
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
 * The bar across the top of any chat but a bot's chat: a project's chat or
 * an automation's feed. Its title, after where it sits as
 * a breadcrumb, then what can be done with it and its Details where it has
 * them. Unlike `ChatHeader` it has no bot's breadcrumb or computer: a
 * project's chat reaches its lead bot's work through its Details.
 */
export function PlainChatHeader({
	title,
	menu,
	resolved,
	within,
	face,
	crumbs,
	overChat = false,
	cards = false,
	back,
	parent,
	trailing,
	details,
}: HeaderPlace & {
	title: string;
	/** From a tablet up, where it sits, before its title as a breadcrumb: "Support / Automations". */
	crumbs?: ReactNode;
	/** What else can be done with it, at the end of the header. */
	menu?: ReactNode;
	/** Whether the chat is resolved, and how to mark it resolved or reopen it; absent on anything but a project's chat. */
	resolved?: ResolvedToggle;
	/** What the chat is in, its project, which a phone names under it. */
	within?: string;
	/** Whose the chat is, as a face, such as an automation's, which a phone shows beside its name. */
	face?: ReactNode;
	/** Over the chat, which scrolls up under it, rather than a bar of its own above it. */
	overChat?: boolean;
	/** Whether its Details float as cards over the chat, as a chat's do, rather than a column beside it. */
	cards?: boolean;
}) {
	const openDetails = details && (() => details.onChange(!details.open));
	return (
		<HeaderBar
			back={back}
			parent={parent}
			plain={overChat}
			badge={
				// A project's chat can be marked resolved, and goes by its title and where it is; anything else by its name.
				resolved ? (
					<HeaderBadge title={title} sub={within && `in ${within}`} onClick={openDetails} />
				) : (
					<HeaderBadge face={face} title={title} onClick={openDetails} />
				)
			}
		>
			{/* The title, after where it sits: "Support / Refund for Acme". A phone shows the badge in its place. */}
			<h1 className="sr-only md:hidden">{title}</h1>
			<div className="hidden min-w-0 flex-1 items-center md:flex">
				<div data-header-title className="flex min-w-0 items-center gap-1.5">
					{crumbs && (
						<>
							{crumbs}
							<CrumbSeparator />
						</>
					)}
					<h1 className="m-0 min-w-0 truncate font-medium text-foreground text-sm">{title}</h1>
				</div>
			</div>
			{resolved?.onChange && (
				<ResolveButton isResolved={resolved.isResolved} onChange={resolved.onChange} />
			)}
			{details && <DetailsButton {...details} cards={cards} />}
			{menu}
			{trailing}
		</HeaderBar>
	);
}

/** Whether a chat is resolved, and what marks it resolved or reopens it. */
export interface ResolvedToggle {
	isResolved: boolean;
	/**
	 * Saves the change, settling on whether it saved; a failure is shown where
	 * the chat is. Absent for a member who may not resolve or reopen it, such
	 * as a viewer.
	 */
	onChange?: (resolved: boolean) => Promise<boolean>;
}

/**
 * Marks the chat resolved, which takes it off the sidebar once it is left, or
 * reopens it; its name, and tooltip, say which it will do.
 */
function ResolveButton({ isResolved, onChange }: Required<ResolvedToggle>) {
	return (
		<IconButton
			label={isResolved ? "Reopen" : "Resolve"}
			variant="bar"
			onClick={() => void onChange(!isResolved)}
			className={HEADER_ICON_CLASS_NAME}
		>
			{isResolved ? (
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
 * the page covers.
 */
export function HeaderBack({ back }: { back: BackTo }) {
	const { label: backLabel } = useLeave();
	const place = useBackPlace(back);
	return (
		<a
			href={place.href}
			aria-label={backLabel(place.name)}
			className={cn(BACK_BUTTON, "md:hidden")}
			onClick={(event) => {
				if (!isPlainClick(event)) return;
				event.preventDefault();
				place.leave();
			}}
		>
			<BackChevron />
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
		case "project":
			return {
				href: router.buildLocation(projectLink(back.project)).href,
				name: back.project.name,
			};
		case "bot":
			return { href: router.buildLocation(botLink(back.bot)).href, name: back.bot.name };
		case "ownerSettings":
			return {
				href: router.buildLocation(ownerLinkOptions(back.owner, { page: "settings" })).href,
				name: "Settings",
			};
	}
}
