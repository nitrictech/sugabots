import type { Agent, Pod, ThreadDetails } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, CircleCheck, Info, Pause, Play, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { useRoutineControls } from "@/lib/chats.ts";
import { activityLink, podLink } from "@/lib/links.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Button } from "@/ui/button.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { ChatSandbox } from "./SandboxButton.tsx";

/** A routine, as its own thread knows it. */
type RoutineStanding = NonNullable<ThreadDetails["routine"]>;

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
 * The bar across the top of a bot's chat: its face and name, what it is for,
 * the way into its sandbox's desktop when it has one, and, with `details`, the
 * way into its Details: the ⓘ, or the name, which is how a phone reaches them.
 */
export function ChatHeader({
	agent,
	title,
	done,
	routine,
	conversationId,
	onOpenDesktop,
	onlyYou = false,
	back,
	trailing,
	details,
}: HeaderPlace & {
	agent: Agent;
	/** The thread's title, shown in place of the bot's name once it is loaded. */
	title?: string;
	/** Whether the thread is done, and how to mark it done or reopen it. */
	done?: DoneToggle;
	/** On a routine's own thread: the routine, which the header pauses and resumes. */
	routine?: RoutineStanding;
	conversationId: string;
	onOpenDesktop: () => void;
	/** The conversation is the viewer's alone, as in their Personal pod, which the header says. */
	onlyYou?: boolean;
}) {
	const description = [agent.description?.replace(/\.$/, ""), onlyYou && "Only you can see this"]
		.filter(Boolean)
		.join(". ");
	const name = (
		<>
			<AgentAvatar
				color={agent.color}
				face={agent.face}
				shape={agent.shape}
				size={24}
				className="shrink-0"
			/>
			<span className="truncate">{title ?? agent.name}</span>
		</>
	);
	return (
		<header className="relative flex h-14 shrink-0 items-center gap-3 border-border border-b pr-4 pl-5 max-md:pl-12">
			<HeaderBack back={back} />
			<h1 className="m-0 flex min-w-0 font-semibold text-[16px] text-foreground">
				{details ? (
					<button
						type="button"
						onClick={() => details.onChange(!details.open)}
						className="focus-ring flex min-w-0 items-center gap-3 rounded-md text-left"
					>
						{name}
					</button>
				) : (
					<span className="flex min-w-0 items-center gap-3">{name}</span>
				)}
			</h1>
			{description ? (
				<>
					<span aria-hidden className="h-5 w-px shrink-0 bg-border-strong max-md:hidden" />
					<p className="m-0 min-w-0 flex-1 truncate text-[13.5px] text-muted-foreground max-md:hidden">
						{description}
					</p>
				</>
			) : (
				<span className="flex-1" />
			)}
			<ChatSandbox agent={agent} threadId={conversationId} onOpen={onOpenDesktop} />
			{done && <DoneButton {...done} />}
			{routine && <RoutinePauseButton conversationId={conversationId} routine={routine} />}
			{details && <DetailsButton {...details} />}
			{trailing}
		</header>
	);
}

/** Pauses the routine whose own thread `conversationId` is, or resumes it. */
function RoutinePauseButton({
	conversationId,
	routine,
}: {
	conversationId: string;
	routine: RoutineStanding;
}) {
	const controls = useRoutineControls(conversationId, routine);
	const paused = routine.state === "paused";
	return (
		<Button
			size="sm"
			variant="outline"
			disabled={controls.pending}
			onClick={() => void controls.setPaused(!paused)}
		>
			{paused ? (
				<Play aria-hidden size={14} strokeWidth={2} />
			) : (
				<Pause aria-hidden size={14} strokeWidth={2} />
			)}
			{paused ? "Resume" : "Pause"}
		</Button>
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
			className="size-8 aria-pressed:bg-chip max-md:hidden"
		>
			<Info size={18} strokeWidth={2} />
		</IconButton>
	);
}

/**
 * The bar across the top of a chat between people, the pod's chat or a thread
 * started from it: what it is called, and what it is for.
 */
export function PeopleChatHeader({
	title,
	tile,
	menu,
	description,
	done,
	back,
	trailing,
	details,
}: HeaderPlace & {
	title: string;
	/** Drawn before the title, such as the pod's tile on its chat. */
	tile?: ReactNode;
	/** What else can be done with it, at the end of the header. */
	menu?: ReactNode;
	description?: string;
	/** Whether the thread is done, and how to mark it done or reopen it; absent on the pod's chat. */
	done?: DoneToggle;
}) {
	return (
		<header className="relative flex h-14 shrink-0 items-center gap-3 border-border border-b pr-4 pl-5 max-md:pl-12">
			<HeaderBack back={back} />
			{tile}
			<h1 className="m-0 min-w-0 truncate font-semibold text-[16px] text-foreground">{title}</h1>
			{description ? (
				<>
					<span aria-hidden className="h-5 w-px shrink-0 bg-border-strong max-md:hidden" />
					<p className="m-0 min-w-0 flex-1 truncate text-[13.5px] text-muted-foreground max-md:hidden">
						{description}
					</p>
				</>
			) : (
				<span className="flex-1" />
			)}
			{done && <DoneButton {...done} />}
			{details && <DetailsButton {...details} />}
			{menu}
			{trailing}
		</header>
	);
}

/** Whether a thread is done, and what marks it done or reopens it. */
export interface DoneToggle {
	isDone: boolean;
	onChange: (done: boolean) => void;
}

/**
 * Marks the thread done, which moves it to the list's Done, or reopens it,
 * saying in words which it will do.
 */
function DoneButton({ isDone, onChange }: DoneToggle) {
	return (
		<Button size="sm" variant="outline" onClick={() => onChange(!isDone)}>
			{isDone ? (
				<RotateCcw aria-hidden size={14} strokeWidth={2} />
			) : (
				<CircleCheck aria-hidden size={14} strokeWidth={2} />
			)}
			{isDone ? "Reopen" : "Mark done"}
		</Button>
	);
}

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
		<Link {...activityLink()} aria-label="Back to Activity" className={className}>
			{chevron}
		</Link>
	);
}
