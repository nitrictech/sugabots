import { useMutation, useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";
import { threadQuery } from "./threads.ts";
import { BROWSER_TOOL_PREFIX } from "./tool-names.ts";

/**
 * Whether the agent is using its desktop in the thread right now: its reply
 * is still being written and has called a browser tool. Read from the thread
 * the chat has loaded and its events keep current, so it asks the API for
 * nothing of its own.
 */
export function useDesktopInUse(threadId: string | undefined, agentId: string): boolean {
	const { data } = useQuery({ ...threadQuery(threadId), enabled: false });
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

/**
 * How often the open pages are checked again, while a person has control. A
 * check takes about a quarter of a second in the sandbox, and never wakes it.
 */
const UNREACHED_SITES_INTERVAL_MS = 2_000;

/**
 * The sites the pages open on the agent's desktop tried and failed to reach
 * because the pod's sandbox doesn't allow them, checked again every couple
 * of seconds while `enabled`: while the person has control and the desktop
 * is connected.
 */
export function useUnreachedSites(threadId: string, agentId: string, enabled: boolean) {
	return useQuery({
		queryKey: ["desktop-unreached-sites", threadId, agentId],
		queryFn: ({ signal }) =>
			Effect.runPromise(
				client.api.threads.desktopUnreachedSites({ params: { threadId, agentId } }),
				{ signal },
			),
		enabled,
		refetchInterval: enabled ? UNREACHED_SITES_INTERVAL_MS : false,
	});
}

/** Loads again the pages on the agent's desktop that failed to reach any of `hosts`, once allowed. */
export function useReloadUnreachedSites(threadId: string, agentId: string) {
	return useMutation({
		mutationFn: (hosts: readonly string[]) =>
			Effect.runPromise(
				client.api.threads.reloadDesktopUnreachedSites({
					params: { threadId, agentId },
					payload: { hosts: [...hosts] },
				}),
			),
	});
}
