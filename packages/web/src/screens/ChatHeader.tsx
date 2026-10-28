import type { Agent, Pod } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronLeft, CircleCheck, PanelRight, RotateCcw, Users } from "lucide-react";
import type { ReactNode } from "react";
import { activityLink, podLink } from "@/lib/links.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { ChatSandbox, PhoneChatSandbox } from "./SandboxButton.tsx";

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
		<>
			<PhoneHeader
				back={back}
				face={<AgentAvatar color={agent.color} face={agent.face} shape={agent.shape} size={52} />}
				name={agent.name}
				details={details}
				trailing={
					<PhoneChatSandbox agent={agent} threadId={conversationId} onOpen={onOpenDesktop} />
				}
			/>
			<HeaderBar>
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
		</>
	);
}

/** The title across the top of a chat, as a page's is: its name, in the same type and place. */
const TITLE_CLASS_NAME = "m-0 min-w-0 flex-1 truncate font-medium text-[14px] text-foreground";

/** The bar across the top of a chat from a tablet up, the same height and inset as a page's. */
function HeaderBar({ children }: { children: ReactNode }) {
	return (
		<header className="relative flex h-[52px] shrink-0 items-center gap-3 border-border border-b pr-4 pl-6 max-md:hidden">
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
	face = <ChatFace icon={<Users />} />,
}: HeaderPlace & {
	title: string;
	/** What a phone shows over its title: a channel's #, the routine's bot, or people. */
	face?: ReactNode;
	/** What else can be done with it, at the end of the header. */
	menu?: ReactNode;
	/** Whether the thread is done, and how to mark it done or reopen it; absent on the pod's chat. */
	done?: DoneToggle;
}) {
	return (
		<>
			<PhoneHeader back={back} face={face} name={title} details={details} />
			<HeaderBar>
				<h1 className={TITLE_CLASS_NAME}>{title}</h1>
				{done && <DoneButton {...done} />}
				{details && <DetailsButton {...details} />}
				{menu}
				{trailing}
			</HeaderBar>
		</>
	);
}

/**
 * A chat's header on a phone, floating over the top of the chat as it fades
 * in under it: Back, its face over its name, which open its Details where it
 * has them, and `trailing`, such as the bot's computer.
 */
function PhoneHeader({
	back,
	face,
	name,
	details,
	trailing,
}: {
	back: BackTo;
	face: ReactNode;
	name: string;
	details?: DetailsToggle;
	trailing?: ReactNode;
}) {
	const nameplate = (
		<>
			<span className="relative z-[1] flex">{face}</span>
			<span className="glass -mt-1.5 flex h-[30px] max-w-[220px] items-center rounded-[15px] px-3">
				<span className="min-w-0 truncate font-medium text-[14px] text-foreground">{name}</span>
			</span>
		</>
	);
	return (
		<div className="pointer-events-none absolute inset-x-0 top-0 z-20 md:hidden">
			<div
				aria-hidden
				className="h-[150px] bg-linear-to-b from-60% from-background to-transparent"
			/>
			<div className="pointer-events-auto absolute inset-x-4 top-[calc(env(safe-area-inset-top)+12px)] flex items-start gap-3">
				<PhoneBack back={back} />
				<span className="flex min-w-0 flex-1 justify-center">
					{details ? (
						<button
							type="button"
							onClick={() => details.onChange(true)}
							aria-label={`${name}: details`}
							className="focus-ring flex min-w-0 max-w-full flex-col items-center rounded-2xl"
						>
							{nameplate}
						</button>
					) : (
						<h1 className="m-0 flex min-w-0 max-w-full flex-col items-center font-medium text-[14px]">
							{nameplate}
						</h1>
					)}
				</span>
				{trailing ?? <span className="w-9 shrink-0" />}
			</div>
		</div>
	);
}

/** A round, frosted Back at the top left of a phone's chat, to the list the chat covers. */
function PhoneBack({ back }: { back: BackTo }) {
	const className =
		"focus-ring glass grid size-9 shrink-0 place-items-center rounded-full text-foreground";
	const chevron = <ChevronLeft aria-hidden size={18} strokeWidth={2.25} />;
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

/** A chat's face where it has no bot's: a rounded tile holding `icon`, as a channel's # or people. */
export function ChatFace({ icon }: { icon: ReactNode }) {
	return (
		<span className="grid size-[52px] place-items-center rounded-[30%] bg-chip text-soft-foreground [&>svg]:size-6 [&>svg]:stroke-[1.75]">
			{icon}
		</span>
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
