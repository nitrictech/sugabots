import type { CollaborationPart, SessionUser } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { useThread } from "@/lib/threads.ts";
import { IconButton } from "@/ui/icon-button.tsx";
import { ParticipantStack } from "./ThreadHeader.tsx";
import { ThreadPage } from "./ThreadPage.tsx";

/*
 * A child thread, shown where the collaboration that opened it happened.
 *
 * The card is only a frame: the header says who is in the thread and how the
 * collaboration stands, and the body is the same `ThreadPage` a person gets by
 * opening the thread on its own, so watching two agents talk here and there
 * is the same view. It arrives expanded when it appears during the
 * conversation, and collapsed when the conversation is revisited later, so an
 * old thread reads as its bubbles with the child threads a click away.
 */

/** Long enough to watch a conversation, short enough that the parent stays scrollable. */
const EXPANDED_MAX_HEIGHT_PX = 560;

export function CollaborationThread({
	collaboration,
	arrivedLive,
	user,
}: {
	collaboration: CollaborationPart;
	/** Whether the reply this sits in is still being written, so the person is watching it happen. */
	arrivedLive: boolean;
	user: SessionUser;
}) {
	const settled = collaboration.status === "answered" || collaboration.status === "failed";
	const [expanded, setExpanded] = useState(arrivedLive || !settled);
	const child = useThread(collaboration.threadId);
	const participants = child.data?.participants ?? [];

	return (
		<section
			aria-label={`Thread with ${collaboration.agentName}`}
			className="agent-tint flex animate-rise flex-col overflow-hidden rounded-2xl border border-agent-wash bg-sunken motion-reduce:animate-none"
			style={{ ["--agent-hue" as string]: participantHue(participants, collaboration.agentId) }}
		>
			<div className="flex items-center gap-3 px-3 py-2.5 pl-3.5">
				<ParticipantStack
					label="People"
					participants={participants.filter((one) => one.kind === "person")}
				/>
				<div className="flex min-w-0 flex-1 flex-col">
					<span className="truncate font-semibold text-heading text-md">
						Asked {collaboration.agentName}: {firstLine(collaboration.brief)}
					</span>
					<span className="text-muted-foreground text-xs">
						{standing(collaboration, child.data?.messages.length)}
					</span>
				</div>
				<ParticipantStack
					label="Bots"
					participants={participants.filter((one) => one.kind === "agent")}
				/>
				<Link
					to="/threads/$thread"
					params={{ thread: collaboration.threadId }}
					search={{ summary: undefined }}
					aria-label="Open thread"
					className="focus-ring grid size-8 shrink-0 place-items-center rounded-xl border border-control-border bg-control text-control-foreground hover:text-heading"
				>
					<ArrowUpRight size={16} />
				</Link>
				<IconButton
					label={expanded ? "Collapse child thread" : "Expand child thread"}
					aria-expanded={expanded}
					onClick={() => setExpanded(!expanded)}
					variant="pane"
					size="lg"
				>
					{expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
				</IconButton>
			</div>
			{expanded && (
				<div
					className="flex min-h-0 animate-unfold flex-col border-border-subtle border-t bg-card motion-reduce:animate-none"
					style={{
						maxHeight: EXPANDED_MAX_HEIGHT_PX,
						["--unfold-to" as string]: `${EXPANDED_MAX_HEIGHT_PX}px`,
					}}
				>
					<ThreadPage threadId={collaboration.threadId} user={user} embedded />
				</div>
			)}
		</section>
	);
}

function standing(collaboration: CollaborationPart, messageCount: number | undefined): string {
	const count = messageCount === undefined ? "" : ` · ${messageCount} messages`;
	switch (collaboration.status) {
		case "waiting":
			return `Working${count}`;
		case "pending":
			return `Waiting on ${collaboration.agentName}${count}`;
		case "answered":
			return `Answered${count}`;
		case "failed":
			return `${collaboration.agentName} could not answer${count}`;
	}
}

function participantHue(
	participants: ReadonlyArray<{ kind: string; id: string; hue?: number }>,
	agentId: string,
): number | undefined {
	const collaborator = participants.find((one) => one.kind === "agent" && one.id === agentId);
	return collaborator && "hue" in collaborator ? collaborator.hue : undefined;
}

function firstLine(text: string): string {
	return text.split(/\r?\n/, 1)[0]?.trim() ?? "";
}
