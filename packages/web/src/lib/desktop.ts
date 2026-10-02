import type { ThreadDetails } from "@sugabots/contracts";
import { useQuery } from "@tanstack/react-query";
import { BROWSER_TOOL_PREFIX } from "./tool-names.ts";

/**
 * Whether the agent is using its desktop in the thread right now: its reply
 * is still being written and has called a browser tool. Read from the thread
 * the chat has loaded and its events keep current, so it asks the API for
 * nothing of its own.
 */
export function useDesktopInUse(threadId: string | undefined, agentId: string): boolean {
	const { data } = useQuery<ThreadDetails>({ queryKey: ["thread", threadId], enabled: false });
	const reply = data?.messages.findLast(
		(message) => message.author.kind === "agent" && message.author.id === agentId,
	);
	return (
		reply?.status === "streaming" &&
		reply.parts.some(
			(part) => part.type === "tool_call" && part.tool.startsWith(BROWSER_TOOL_PREFIX),
		)
	);
}
