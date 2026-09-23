import type { Agent, SessionUser } from "@sugabots/contracts";
import { useNavigate } from "@tanstack/react-router";
import { usePods } from "@/lib/pods.ts";
import { SurfaceGlow } from "@/ui/surface.tsx";
import { AgentChat } from "./AgentChat.tsx";
import { AgentPaneHeader } from "./AgentHeaderIdentity.tsx";

export function AgentPage({
	agent,
	requestedPodId,
	user,
	threadId,
	historyOpen,
}: {
	agent: Agent;
	requestedPodId?: string;
	user: SessionUser;
	threadId?: string;
	historyOpen: boolean;
}) {
	const navigate = useNavigate();
	const { data: pods } = usePods();
	const pod =
		pods?.find((candidate) => candidate.id === requestedPodId) ??
		pods?.find((candidate) => candidate.id === agent.podId);
	const updateSearch = (change: { thread?: string; history?: "open" }) =>
		navigate({
			to: "/agents/$agent",
			params: { agent: agent.id },
			search: (previous) => ({ ...previous, ...change, pod: pod?.id }),
		});

	return (
		<div
			className="agent-tint flex min-h-0 flex-1 flex-col overflow-hidden"
			style={{ ["--agent-hue" as string]: agent.hue }}
		>
			<SurfaceGlow hue={agent.hue} />
			<AgentPaneHeader agent={agent} section="Chat" linkToSettings context={pod?.name} />
			{pod && (
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
			)}
		</div>
	);
}
