import { botColorVariables } from "@sugabots/avatars";
import type { ThreadParticipant } from "@sugabots/contracts";
import { cn } from "cn";
import { AgentAvatar } from "@/shell/Agent.tsx";

type AgentParticipant = Extract<ThreadParticipant, { kind: "agent" }>;

/**
 * A bot at work on its reply: its face beside a bubble of three dots, where the
 * reply will land. What it is doing meanwhile is the tool line above.
 */
export function TypingIndicator({
	agent,
	outgoing = false,
	compact = false,
}: {
	agent: Pick<AgentParticipant, "name" | "color" | "face">;
	/** Drawn on the right, where this bot's messages are. */
	outgoing?: boolean;
	/** The sidebar's smaller face. */
	compact?: boolean;
}) {
	return (
		<div
			role="status"
			aria-label={`${agent.name} is typing`}
			className={cn("flex items-end gap-2 pt-3.5", outgoing && "flex-row-reverse")}
			style={botColorVariables(agent.color)}
		>
			<AgentAvatar color={agent.color} face={agent.face} size={compact ? 26 : 34} />
			<span
				className={cn(
					"bg-bot-tint px-[15px] py-[13px] text-bot-mono",
					outgoing ? "rounded-[20px_20px_6px_20px]" : "rounded-[20px_20px_20px_6px]",
				)}
			>
				<span aria-hidden className="typing-dots">
					<i />
					<i />
					<i />
				</span>
			</span>
		</div>
	);
}
