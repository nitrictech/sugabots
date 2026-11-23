import type { ChatHistoryEntry, ChatMessageItem, Message } from "@sugabots/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useLayoutEffect, useRef } from "react";
import { ownerLinkOptions, type ResourceOwner } from "@/lib/resource-owner.tsx";
import { messagesIn } from "./chat-items.ts";

/**
 * Opens a collaboration beside a chat, and gives the focus back to whatever
 * opened it once it closes. A run is never opened beside a chat: its
 * automation's page opens in the chat's place, unless the chat is that
 * automation's feed already.
 */
export function useNestedChatOpening({
	nestedChatId,
	loaded,
	items,
	owner,
	feedOfAutomationId,
	onNestedChatChange,
}: {
	/** The nested chat open beside the chat, if any. */
	nestedChatId: string | undefined;
	/** Whether the chat has loaded, so what opened a nested chat is on the page. */
	loaded: boolean;
	items: readonly ChatMessageItem[];
	/** Whose the chat is, a bot or a project, whose automation a run opens. */
	owner: ResourceOwner;
	/** The automation whose feed the chat is, when it is one. */
	feedOfAutomationId: string | undefined;
	onNestedChatChange: (nestedChatId: string | undefined) => void;
}): (nestedChatId: string) => void {
	const navigate = useNavigate();
	const opener = useRef<HTMLElement | null>(null);
	const previousNestedChatId = useRef<string | undefined>(undefined);

	useLayoutEffect(() => {
		if (!loaded) return;
		if (nestedChatId && !previousNestedChatId.current) {
			opener.current = document.activeElement as HTMLElement;
		}
		if (!nestedChatId && previousNestedChatId.current)
			requestAnimationFrame(() => opener.current?.focus());
		previousNestedChatId.current = nestedChatId;
	}, [loaded, nestedChatId]);

	const runs = runsShownIn(items);
	return (nextNestedChatId) => {
		if (runs.chatIds.has(nextNestedChatId)) {
			const run = runs.resulting.get(nextNestedChatId);
			if (run && run.automationId !== feedOfAutomationId) {
				void navigate(
					ownerLinkOptions(owner, { page: "automation", automationId: run.automationId }),
				);
			}
			return;
		}
		opener.current = document.activeElement as HTMLElement;
		onNestedChatChange(nextNestedChatId);
	};
}

/**
 * Whether the nested chat `nestedChatId` names opens beside the chat, in its
 * Details' place: a collaboration does, a run never does.
 */
export function opensBeside(
	nestedChatId: string | undefined,
	entries: readonly ChatHistoryEntry[],
): boolean {
	return (
		nestedChatId !== undefined &&
		entries.find((entry) => entry.chatId === nestedChatId)?.kind !== "run"
	);
}

type RunResulting = NonNullable<Message["automationResultOf"]>;

/**
 * The automation runs `items` shows, by the run's chat: those whose
 * results are among its messages, and every run shown, as a result or a row
 * of its own.
 */
function runsShownIn(items: readonly ChatMessageItem[]): {
	resulting: ReadonlyMap<string, RunResulting>;
	chatIds: ReadonlySet<string>;
} {
	const resulting = new Map(
		messagesIn(items).flatMap((message) =>
			message.automationResultOf
				? [[message.automationResultOf.chatId, message.automationResultOf] as const]
				: [],
		),
	);
	const chatIds = new Set([
		...resulting.keys(),
		...items.flatMap((item) => (item.kind === "run" ? [item.chatId] : [])),
	]);
	return { resulting, chatIds };
}
