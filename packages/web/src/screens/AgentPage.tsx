import { botColorVariables } from "@sugabots/avatars";
import type { Agent, Pod, SessionUser } from "@sugabots/contracts";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Info } from "lucide-react";
import { useState } from "react";
import { allLink, podLink } from "@/lib/links.ts";
import { matchesMedia, SIDEBAR_BESIDE } from "@/lib/media.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";
import { AgentChat } from "./AgentChat.tsx";

export function AgentPage({
	agent,
	pod,
	user,
	threadId,
	onThreadChange,
}: {
	agent: Agent;
	pod: Pod;
	user: SessionUser;
	threadId?: string;
	onThreadChange: (threadId: string | undefined) => void;
}) {
	// Open from the start where it sits beside the chat; on a smaller screen it would cover it.
	const [detailsOpen, setDetailsOpen] = useState(() => matchesMedia(SIDEBAR_BESIDE));

	return (
		<div
			className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
			style={botColorVariables(agent.color)}
		>
			<ChatHeader
				agent={agent}
				pod={pod}
				detailsOpen={detailsOpen}
				onDetailsChange={setDetailsOpen}
			/>
			<AgentChat
				key={`${pod.id}:${agent.id}`}
				agent={agent}
				pod={pod}
				user={user}
				threadId={threadId}
				detailsOpen={detailsOpen}
				onDetailsClose={() => setDetailsOpen(false)}
				onThreadChange={onThreadChange}
			/>
		</div>
	);
}

/**
 * The bot's face, name and pod across the top of its chat, with the way into
 * its Details: the ⓘ, or the face and name themselves, which is how a phone
 * reaches them. On a phone the chat covers the list, so Back returns to it.
 */
const backClass =
	"focus-ring absolute top-3 left-2 grid size-9 shrink-0 place-items-center rounded-full text-link md:hidden";

function ChatHeader({
	agent,
	pod,
	detailsOpen,
	onDetailsChange,
}: {
	agent: Agent;
	pod: Pod;
	detailsOpen: boolean;
	onDetailsChange: (open: boolean) => void;
}) {
	const matchRoute = useMatchRoute();
	const fromAll = Boolean(matchRoute({ to: "/$workspace/all", fuzzy: true }));
	return (
		// On a phone the design centres the bot: its face over its name, and Back to the left.
		<header className="relative flex shrink-0 items-center gap-3 border-border-subtle border-b bg-list/70 px-[22px] py-3.5 max-md:justify-center max-md:px-12 max-md:pt-2.5 max-md:pb-2">
			{fromAll ? (
				<Link {...allLink()} aria-label="Back to All" className={backClass}>
					<ChevronLeft size={24} strokeWidth={2.2} />
				</Link>
			) : (
				<Link {...podLink(pod)} aria-label={`Back to ${pod.name}`} className={backClass}>
					<ChevronLeft size={24} strokeWidth={2.2} />
				</Link>
			)}
			{/* The name's button stretches over the face and pod too, so the whole of it opens Details. */}
			<div className="relative flex min-w-0 flex-1 items-center gap-3 max-md:flex-none max-md:flex-col max-md:gap-1.5">
				<AgentAvatar color={agent.color} face={agent.face} size={40} className="max-md:size-14" />
				<div className="flex min-w-0 flex-1 flex-col gap-px max-md:items-center">
					<h1 className="m-0 truncate font-bold text-base text-foreground max-md:font-semibold max-md:text-[14.5px]">
						<button
							type="button"
							onClick={() => onDetailsChange(!detailsOpen)}
							className="focus-ring inline-flex items-center gap-0.5 rounded-md text-left after:absolute after:inset-0 after:content-['']"
						>
							{agent.name}
							<ChevronRight
								aria-hidden
								size={14}
								strokeWidth={2.4}
								className="text-subtle-foreground md:hidden"
							/>
						</button>
					</h1>
					<p className="m-0 truncate text-muted-foreground text-sm max-md:hidden">{pod.name}</p>
				</div>
			</div>
			<Tooltip label="Details">
				<button
					type="button"
					aria-label="Details"
					aria-pressed={detailsOpen}
					onClick={() => onDetailsChange(!detailsOpen)}
					className="focus-ring grid size-9 shrink-0 place-items-center rounded-full text-soft-foreground transition-colors hover:bg-chip aria-pressed:bg-chip max-md:hidden"
				>
					<Info size={19} strokeWidth={2} />
				</button>
			</Tooltip>
		</header>
	);
}
