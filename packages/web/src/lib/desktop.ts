import { useQuery } from "@tanstack/react-query";
import { type RefObject, useEffect, useRef, useState } from "react";
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
 * How long a viewer of the desktop or browser stays connected while neither
 * the person nor the agent uses it. A connection holds the sandbox awake, so
 * a forgotten tab would keep it running for as long as the tab stays open.
 */
export const IDLE_TIMEOUT_MINUTES = 5;
const IDLE_CHECK_INTERVAL_MS = 30 * 1000;
const INPUT_EVENTS = ["pointerdown", "pointermove", "wheel", "keydown"] as const;

/**
 * Whether a viewer has gone {@link IDLE_TIMEOUT_MINUTES} without the person's
 * input on `element` or a browser call from the agent, counted again from
 * each new `attempt` to connect.
 */
export function useViewerIdle(
	element: RefObject<HTMLElement | null>,
	threadId: string,
	agentId: string,
	attempt: number,
): boolean {
	const [idle, setIdle] = useState(false);
	const agentUsing = useDesktopInUse(threadId, agentId);
	const agentUsingNow = useRef(agentUsing);
	useEffect(() => {
		agentUsingNow.current = agentUsing;
	}, [agentUsing]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt counts again.
	useEffect(() => {
		const target = element.current;
		if (!target) return;
		setIdle(false);
		let lastUsedAt = Date.now();
		const used = () => {
			lastUsedAt = Date.now();
		};
		// Captured before the viewers' own handlers, which may stop keys from bubbling.
		for (const event of INPUT_EVENTS) target.addEventListener(event, used, { capture: true });
		const check = setInterval(() => {
			if (agentUsingNow.current) used();
			if (Date.now() - lastUsedAt >= IDLE_TIMEOUT_MINUTES * 60_000) setIdle(true);
		}, IDLE_CHECK_INTERVAL_MS);
		return () => {
			clearInterval(check);
			for (const event of INPUT_EVENTS) target.removeEventListener(event, used, { capture: true });
		};
	}, [element, threadId, agentId, attempt]);

	return idle;
}
