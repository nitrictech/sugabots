import type { Agent, Pod, SessionUser } from "@sugabots/contracts";
import { useNavigate } from "@tanstack/react-router";
import { SurfaceGlow } from "@/ui/surface.tsx";
import { AgentChat } from "./AgentChat.tsx";
import { AgentPaneHeader } from "./AgentHeaderIdentity.tsx";

export function AgentPage({
	agent,
	pod,
	user,
	threadId,
	historyOpen,
}: {
	agent: Agent;
	pod: Pod;
	user: SessionUser;
	threadId?: string;
	historyOpen: boolean;
}) {
	const navigate = useNavigate();
	const updateSearch = (change: { thread?: string; history?: "open" }) =>
		navigate({
			from: "/$workspace/pods/$pod/agents/$agent",
			to: ".",
			search: (previous) => ({ ...previous, ...change }),
		});

	return (
		<div
			className="agent-tint flex min-h-0 flex-1 flex-col overflow-hidden"
			style={{ ["--agent-hue" as string]: agent.hue }}
		>
			<SurfaceGlow hue={agent.hue} />
			<AgentPaneHeader agent={agent} section="Chat" linkToSettings context={pod.name} />
			<AgentChat
				key={`${pod.id}:${agent.id}`}
				agent={agent}
				pod={pod}
				user={user}
				threadId={threadId}
				historyOpen={historyOpen}
				onHistoryChange={(open) => void updateSearch({ history: open ? "open" : undefined })}
				onThreadChange={(nextThreadId) => void updateSearch({ thread: nextThreadId })}
			/>
		</div>
	);
}
