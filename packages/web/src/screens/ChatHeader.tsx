import type { Agent, Pod } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, Info } from "lucide-react";
import type { ReactNode } from "react";
import { activityLink, podLink } from "@/lib/links.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
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
 * them. On a phone the chat covers the list, so Back returns to it.
 */
export function ChatHeader({ agent, pod, place }: { agent: Agent; pod: Pod; place: ChatPlace }) {
	const name = (
		<>
			<AgentAvatar color={agent.color} face={agent.face} size={24} className="shrink-0" />
			<span className="truncate">{agent.name}</span>
		</>
	);
	return (
		<header className="relative flex h-14 shrink-0 items-center gap-3 border-border border-b pr-4 pl-5 max-md:pl-12">
			<HeaderBack back={place.kind === "away" ? place.back : { to: "pod", pod }} />
			<h1 className="m-0 flex min-w-0 shrink-0 font-semibold text-[16px] text-foreground max-md:shrink">
				{place.kind === "own" ? (
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
			<ChatSandbox agent={agent} pod={pod} />
			{place.kind === "own" ? (
				<IconButton
					label="Details"
					variant="bar"
					aria-pressed={place.detailsOpen}
					onClick={() => place.onDetailsChange(!place.detailsOpen)}
					className="size-8 aria-pressed:bg-chip max-md:hidden"
				>
					<Info size={18} strokeWidth={2} />
				</IconButton>
			) : (
				place.trailing
			)}
		</header>
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
