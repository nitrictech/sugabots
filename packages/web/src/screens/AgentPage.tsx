import { botColorVariables } from "@sugabots/avatars";
import type { Agent, Pod, SessionUser } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Info } from "lucide-react";
import { useState } from "react";
import { useChat } from "@/lib/chats.ts";
import { useDesktopInUse } from "@/lib/desktop.ts";
import { podLink } from "@/lib/links.ts";
import { matchesMedia, SIDEBAR_BESIDE } from "@/lib/media.ts";
import { useSandboxAccess } from "@/lib/sandbox-providers.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";
import { AgentChat } from "./AgentChat.tsx";
import { SandboxButton } from "./SandboxButton.tsx";

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
 * reaches them, and into its sandbox's desktop when it has one. On a phone
 * the chat covers the list, so Back returns to it.
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
	return (
		// On a phone the design centres the bot: its face over its name, and Back to the left.
		<header className="relative flex shrink-0 items-center gap-3 border-border-subtle border-b bg-list/70 px-[22px] py-3.5 max-md:justify-center max-md:px-12 max-md:pt-2.5 max-md:pb-2">
			<Link {...podLink(pod)} aria-label={`Back to ${pod.name}`} className={backClass}>
				<ChevronLeft size={24} strokeWidth={2.2} />
			</Link>
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
			<ChatSandbox agent={agent} pod={pod} />
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

/**
 * The bot's sandbox, for its chat: there while the workspace has sandboxes
 * and the bot uses one. On a phone it sits at the right of the centred header.
 */
function ChatSandbox({ agent, pod }: { agent: Agent; pod: Pod }) {
	const threadId = useChat(pod, agent.id).data?.mainThreadId;
	const sandboxesOn = useSandboxAccess().data?.enabled === true;
	const inUse = useDesktopInUse(threadId, agent.id);
	if (!agent.usesSandbox || !sandboxesOn || !threadId) return null;
	return (
		<div className="max-md:absolute max-md:top-3 max-md:right-2">
			<SandboxButton threadId={threadId} agentId={agent.id} agentName={agent.name} inUse={inUse} />
		</div>
	);
}
