import { botColorVariables } from "@sugabots/avatars";
import type { Agent, Pod, SessionUser } from "@sugabots/contracts";
import type { ReactNode } from "react";
import { useDetailsOpen } from "@/lib/details-open.ts";
import { AgentChat } from "./AgentChat.tsx";
import type { BackTo } from "./ChatHeader.tsx";

interface AgentPageProps {
	agent: Agent;
	pod: Pod;
	user: SessionUser;
	threadId?: string;
	/** A message to jump to and point out, such as the mention it was opened from. */
	focusMessageId?: string;
	/**
	 * Shown away from the chat's own page, as Activity shows it: no Details,
	 * and the header's Back and right-hand link in their places.
	 */
	away?: { back: BackTo; trailing: ReactNode };
	onThreadChange: (threadId: string | undefined) => void;
}

export function AgentPage({ away, ...chat }: AgentPageProps) {
	return (
		<div
			className="relative flex min-h-0 flex-1 overflow-hidden"
			style={botColorVariables(chat.agent.color)}
		>
			{away ? (
				<AgentChat key={chatKey(chat)} {...chat} place={{ kind: "away", ...away }} />
			) : (
				<OwnPageChat {...chat} />
			)}
		</div>
	);
}

/**
 * The chat on its own page, with Details open or closed as this device last
 * left them. Details stay as they are from one chat to the next.
 */
function OwnPageChat(chat: Omit<AgentPageProps, "away">) {
	const [detailsOpen, setDetailsOpen] = useDetailsOpen();
	return (
		<AgentChat
			key={chatKey(chat)}
			{...chat}
			place={{ kind: "own", detailsOpen, onDetailsChange: setDetailsOpen }}
		/>
	);
}

/** Another chat starts fresh: its scroll, its draft's audience, and what it jumped to. */
function chatKey({ pod, agent }: { pod: Pod; agent: Agent }): string {
	return `${pod.id}:${agent.id}`;
}
