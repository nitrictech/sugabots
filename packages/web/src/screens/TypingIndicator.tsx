import type { ThreadParticipant } from "@sugabots/contracts";
import { AgentAvatar } from "@/shell/Agent.tsx";

/*
 * What the thread says while an agent's turn is running: one quiet line, no
 * container, in place of the reply. The reply itself is only drawn once it is
 * finished — what an agent writes on the way can turn out to be the lead-in to
 * a tool call, which cannot be told until the call arrives — so this line is
 * the whole of the turn until then.
 */

type AgentParticipant = Extract<ThreadParticipant, { kind: "agent" }>;

export function TypingIndicator({
	agent,
	waitingOn,
	outgoing = false,
}: {
	agent: Pick<AgentParticipant, "name" | "hue" | "face">;
	/** The collaborator the agent has asked and is waiting to hear from. */
	waitingOn?: string;
	/** Sits under the agent, so it follows the side the agent's bubbles are on. */
	outgoing?: boolean;
}) {
	return (
		<div
			role="status"
			aria-label={`${agent.name}, ${waitingOn ? "waiting" : "typing"}`}
			className={`agent-tint flex items-center gap-2 text-muted-foreground text-xs ${
				outgoing ? "flex-row-reverse pr-3.5 pl-8" : "pr-8 pl-3.5"
			}`}
			style={{ ["--agent-hue" as string]: agent.hue }}
		>
			<AgentAvatar hue={agent.hue} face={agent.face} size={20} />
			<span className="flex min-w-0 items-center gap-1.5">
				<span className="shrink-0 font-semibold text-agent-name">{agent.name}</span>
				<span className="min-w-0 truncate">
					{waitingOn ? `is waiting on ${waitingOn}` : "is typing"}
				</span>
			</span>
			<span className="chat-working-dots" aria-hidden>
				<i />
				<i />
				<i />
			</span>
		</div>
	);
}
