import type { Agent, Pod } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronLeft, CircleCheck, PanelRight, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { activityLink, podLink } from "@/lib/links.ts";
import { IconButton } from "@/ui/icon-button.tsx";
import { ChatSandbox } from "./SandboxButton.tsx";

/** The list a page covers on a phone, which its Back returns to. */
export type BackTo = { to: "pod"; pod: Pod } | { to: "activity" };

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
	return (
		<HeaderBar back={back}>
			<h1 className={TITLE_CLASS_NAME}>
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
			<ChatSandbox agent={agent} threadId={conversationId} onOpen={onOpenDesktop} />
			{done && <DoneButton {...done} />}
			{details && <DetailsButton {...details} />}
			{trailing}
		</HeaderBar>
	);
}

/** The title across the top of a chat, as a page's is: its name, in the same type and place. */
const TITLE_CLASS_NAME = "m-0 min-w-0 flex-1 truncate font-medium text-[14px] text-foreground";

/** The bar across the top of a chat: Back on a phone, then what goes in it, the same height and inset as a page's. */
function HeaderBar({ back, children }: { back: BackTo; children: ReactNode }) {
	return (
		<header className="relative flex h-[52px] shrink-0 items-center gap-3 border-border border-b pr-4 pl-6 max-md:pl-12">
			<HeaderBack back={back} />
			{children}
		</header>
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
	back,
	trailing,
	details,
}: HeaderPlace & {
	title: string;
	/** What else can be done with it, at the end of the header. */
	menu?: ReactNode;
	/** Whether the thread is done, and how to mark it done or reopen it; absent on the pod's chat. */
	done?: DoneToggle;
}) {
	return (
		<HeaderBar back={back}>
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
	onChange: (done: boolean) => void;
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
			onClick={() => onChange(!isDone)}
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

/** An icon button in a chat's header, quieter until pointed at, and shaded while what it opens is open. */
export const HEADER_ICON_CLASS_NAME =
	"text-muted-foreground hover:text-foreground aria-pressed:bg-row-selected aria-pressed:text-foreground";

/** The round Back a phone shows at the left of a page's header, to the list the page covers. */
export function HeaderBack({ back }: { back: BackTo }) {
	const className =
		"focus-ring absolute left-2 grid size-9 place-items-center rounded-full text-link md:hidden";
	const chevron = <ChevronLeft size={24} strokeWidth={2.2} />;
	return back.to === "pod" ? (
		<Link {...podLink(back.pod)} aria-label={`Back to ${back.pod.name}`} className={className}>
			{chevron}
		</Link>
	) : (
		<Link {...activityLink()} aria-label="Back to Inbox" className={className}>
			{chevron}
		</Link>
	);
}
