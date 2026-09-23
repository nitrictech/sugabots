import type { ThreadDetails } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { Ellipsis, Octagon, PanelRightClose, PanelRightOpen, SquarePen } from "lucide-react";
import { useThreadPanel } from "@/lib/thread-panel.tsx";
import { useCancelTurn } from "@/lib/threads.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { AgentPaneHeader } from "./AgentHeaderIdentity.tsx";
import { ThreadPicker } from "./ThreadPicker.tsx";

export function ThreadHeader({ details }: { details: ThreadDetails }) {
	const agents = details.participants.filter((participant) => participant.kind === "agent");
	const people = details.participants.filter((participant) => participant.kind === "person");
	const host = agents.find((participant) => participant.id === details.thread.hostAgentId);
	if (!host) {
		return null;
	}

	return (
		<AgentPaneHeader agent={host} section={details.thread.title} linkToSettings>
			<div className="flex w-full items-center justify-end gap-5 border-border-subtle border-t pt-3 md:w-auto md:border-0 md:pt-0">
				{details.thread.parentThreadId && (
					<Link
						to="/threads/$thread"
						params={{ thread: details.thread.parentThreadId }}
						search={{ summary: undefined }}
						className="font-semibold text-muted-foreground text-xs underline-offset-2 hover:underline"
					>
						Back to the thread that asked
					</Link>
				)}
				<ParticipantStack label="Agents" participants={agents} />
				<span aria-hidden className="h-6 w-px bg-border-subtle" />
				<ParticipantStack label="People" participants={people} />
				<span aria-hidden className="h-6 w-px bg-border-subtle" />
				<NewChatButton agentId={host.id} podId={details.thread.podId} />
				<ThreadPicker
					agent={host}
					podId={details.thread.podId}
					currentThreadId={details.thread.id}
				/>
				<ThreadSummaryToggle />
				{details.activeTurnId && (
					<ThreadActions threadId={details.thread.id} turnId={details.activeTurnId} />
				)}
			</div>
		</AgentPaneHeader>
	);
}

/**
 * Returns to the agent's main Chat from a work-artifact thread.
 */
function NewChatButton({ agentId, podId }: { agentId: string; podId: string }) {
	return (
		<IconButton
			label="New chat"
			variant="pane"
			size="lg"
			render={<Link to="/agents/$agent" params={{ agent: agentId }} search={{ pod: podId }} />}
		>
			<SquarePen size={17} />
		</IconButton>
	);
}

function ThreadSummaryToggle() {
	const { summaryOpen, setSummaryOpen } = useThreadPanel();
	const label = summaryOpen ? "Hide chat summary" : "Show chat summary";
	return (
		<IconButton
			label={label}
			aria-pressed={summaryOpen}
			onClick={() => setSummaryOpen(!summaryOpen)}
			variant="pane"
			size="lg"
			className="hidden xl:grid"
		>
			{summaryOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
		</IconButton>
	);
}

function ThreadActions({ threadId, turnId }: { threadId: string; turnId: string }) {
	const cancel = useCancelTurn(threadId);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label="Thread actions"
				className="focus-ring grid size-9 shrink-0 place-items-center rounded-xl bg-sunken text-muted-foreground hover:text-heading"
			>
				<Ellipsis size={18} />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem
					variant="destructive"
					disabled={cancel.isPending}
					onClick={() => cancel.mutate(turnId)}
				>
					<Octagon />
					{cancel.isPending ? "Stopping…" : "Stop turn"}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export function ParticipantStack({
	label,
	participants,
}: {
	label: string;
	participants: ThreadDetails["participants"];
}) {
	const shown = participants.slice(0, 3);
	const hidden = participants.length - shown.length;
	return (
		<section
			className="flex min-w-0 items-center gap-2"
			aria-label={`${label}: ${participants.map((one) => one.name).join(", ")}`}
		>
			<span className="font-semibold text-subtle-foreground text-2xs uppercase tracking-[0.06em]">
				{label}
			</span>
			<span className="flex items-center" aria-hidden>
				{shown.map((participant, index) =>
					participant.kind === "agent" ? (
						<AgentAvatar
							key={participant.id}
							hue={participant.hue}
							face={participant.face}
							size={30}
							ringed
							className={index > 0 ? "-ml-2" : undefined}
						/>
					) : (
						<PersonAvatar
							key={participant.id}
							name={participant.name}
							email={participant.email}
							image={participant.image}
							size={30}
							className={
								index > 0 ? "-ml-2 border-[2.5px] border-card" : "border-[2.5px] border-card"
							}
						/>
					),
				)}
				{hidden > 0 && (
					<span className="-ml-2 grid size-[30px] place-items-center rounded-full border-[2.5px] border-card bg-muted font-semibold text-subtle-foreground text-2xs">
						+{hidden}
					</span>
				)}
			</span>
		</section>
	);
}
