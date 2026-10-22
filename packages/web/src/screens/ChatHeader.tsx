import type { Agent, Pod } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, CircleCheck, Info, Pause, Play, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { activityLink, podLink } from "@/lib/links.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Button } from "@/ui/button.tsx";
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

/**
 * The bar across the top of a bot's chat: its face and name, what it is for,
 * the way into its sandbox's desktop when it has one, and, on its own page,
 * the way into its Details: the ⓘ, or the name, which is how a phone reaches
 * them. Not while something is staged beside the chat, which takes Details'
 * place. On a phone the chat covers the list, so Back returns to it.
 */
export function ChatHeader({
	agent,
	title,
	done,
	routine,
	pod,
	conversationId,
	place,
	staged,
	onOpenDesktop,
}: {
	agent: Agent;
	/** The thread's title, shown in place of the bot's name once it is loaded. */
	title?: string;
	/** Whether the thread is done, and how to mark it done or reopen it. */
	done?: DoneToggle;
	/** On a routine's own thread: whether the routine is paused, and how to pause or resume it. */
	routine?: { paused: boolean; pending: boolean; onPausedChange: (paused: boolean) => void };
	pod: Pod;
	conversationId: string;
	place: ChatPlace;
	/** Whether something is open large beside the chat, such as an artifact or the desktop. */
	staged: boolean;
	onOpenDesktop: () => void;
}) {
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
			<HeaderBack back={place.kind === "away" ? place.back : { to: "pod", pod }} />
			<h1 className="m-0 flex min-w-0 shrink-0 font-semibold text-[16px] text-foreground max-md:shrink">
				{place.kind === "own" && !staged ? (
					<button
						type="button"
						onClick={() => place.onDetailsChange(!place.detailsOpen)}
						className="focus-ring flex min-w-0 items-center gap-3 rounded-md text-left"
					>
						{name}
					</button>
				) : (
					<span className="flex min-w-0 items-center gap-3">{name}</span>
				)}
			</h1>
			{agent.description ? (
				<>
					<span aria-hidden className="h-5 w-px shrink-0 bg-border-strong max-md:hidden" />
					<p className="m-0 min-w-0 flex-1 truncate text-[13.5px] text-muted-foreground max-md:hidden">
						{agent.description}
					</p>
				</>
			) : (
				<span className="flex-1" />
			)}
			<ChatSandbox agent={agent} threadId={conversationId} onOpen={onOpenDesktop} />
			{done && <DoneButton {...done} />}
			{routine && (
				<Button
					size="sm"
					variant="outline"
					disabled={routine.pending}
					onClick={() => routine.onPausedChange(!routine.paused)}
				>
					{routine.paused ? (
						<Play aria-hidden size={14} strokeWidth={2} />
					) : (
						<Pause aria-hidden size={14} strokeWidth={2} />
					)}
					{routine.paused ? "Resume" : "Pause"}
				</Button>
			)}
			{place.kind === "away" ? (
				place.trailing
			) : staged ? null : (
				<IconButton
					label="Details"
					variant="bar"
					aria-pressed={place.detailsOpen}
					onClick={() => place.onDetailsChange(!place.detailsOpen)}
					className="size-8 aria-pressed:bg-chip max-md:hidden"
				>
					<Info size={18} strokeWidth={2} />
				</IconButton>
			)}
		</header>
	);
}

/**
 * The bar across the top of a chat between people, the pod's chat or a thread
 * started from it: what it is called, and what it is for. Shown away from its
 * own page, as Activity shows it, it has the way to the chat itself at the
 * right.
 */
export function PeopleChatHeader({
	title,
	description,
	done,
	pod,
	place,
}: {
	title: string;
	description?: string;
	/** Whether the thread is done, and how to mark it done or reopen it; absent on the pod's chat. */
	done?: DoneToggle;
	pod: Pod;
	place: ChatPlace;
}) {
	return (
		<header className="relative flex h-14 shrink-0 items-center gap-3 border-border border-b pr-4 pl-5 max-md:pl-12">
			<HeaderBack back={place.kind === "away" ? place.back : { to: "pod", pod }} />
			<h1 className="m-0 min-w-0 shrink-0 truncate font-semibold text-[16px] text-foreground max-md:shrink">
				{title}
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
			{done && <DoneButton {...done} />}
			{place.kind === "away" && place.trailing}
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
