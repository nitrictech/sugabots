import type { ChatHistoryEntry, ChatMessageItem } from "@sugabots/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useLayoutEffect, useRef } from "react";
import { ownerLinkOptions, type ResourceOwner } from "@/lib/resource-owner.tsx";
import { type ChatMessage, messagesIn } from "./chat-items.ts";

/**
 * Opens a collaboration beside a chat, and gives the focus back to whatever
 * opened it once it closes. A run is never opened beside a chat: its
 * automation's page opens in the chat's place, unless the chat is that
 * automation's feed already.
 */
export function useItemOpening({
	itemConversationId,
	loaded,
	items,
	owner,
	feedOfAutomationId,
	onItemChange,
}: {
	/** The item open beside the chat, if any. */
	itemConversationId: string | undefined;
	/** Whether the chat has loaded, so what opened an item is on the page. */
	loaded: boolean;
	items: readonly ChatMessageItem[];
	/** Whose the chat is, a bot or a project, whose automation a run opens. */
	owner: ResourceOwner;
	/** The automation whose feed the chat is, when it is one. */
	feedOfAutomationId: string | undefined;
	onItemChange: (itemConversationId: string | undefined) => void;
}): (itemConversationId: string) => void {
	const navigate = useNavigate();
	const opener = useRef<HTMLElement | null>(null);
	const previousItemConversationId = useRef<string | undefined>(undefined);

	useLayoutEffect(() => {
		if (!loaded) return;
		if (itemConversationId && !previousItemConversationId.current) {
			opener.current = document.activeElement as HTMLElement;
		}
		if (!itemConversationId && previousItemConversationId.current)
			requestAnimationFrame(() => opener.current?.focus());
		previousItemConversationId.current = itemConversationId;
	}, [loaded, itemConversationId]);

	const runs = runsShownIn(items);
	return (nextItemConversationId) => {
		if (runs.conversationIds.has(nextItemConversationId)) {
			const run = runs.resulting.get(nextItemConversationId);
			if (run && run.automationId !== feedOfAutomationId) {
				void navigate(
					ownerLinkOptions(owner, { page: "automation", automationId: run.automationId }),
				);
			}
			return;
		}
		opener.current = document.activeElement as HTMLElement;
		onItemChange(nextItemConversationId);
	};
}

/**
 * Whether the item `itemConversationId` names opens beside the chat, in its
 * Details' place: a collaboration does, a run never does.
 */
export function opensBeside(
	itemConversationId: string | undefined,
	entries: readonly ChatHistoryEntry[],
): boolean {
	return (
		itemConversationId !== undefined &&
		entries.find((entry) => entry.conversationId === itemConversationId)?.kind !== "run"
	);
}

type RunResulting = NonNullable<ChatMessage["automationResultOf"]>;

/**
 * The automation runs `items` shows, by the run's conversation: those whose
 * results are among its messages, and every run shown, as a result or a row
 * of its own.
 */
function runsShownIn(items: readonly ChatMessageItem[]): {
	resulting: ReadonlyMap<string, RunResulting>;
	conversationIds: ReadonlySet<string>;
} {
	const resulting = new Map(
		messagesIn(items).flatMap((message) =>
			message.automationResultOf
				? [[message.automationResultOf.conversationId, message.automationResultOf] as const]
				: [],
		),
	);
	const conversationIds = new Set([
		...resulting.keys(),
		...items.flatMap((item) => (item.kind === "run" ? [item.conversationId] : [])),
	]);
	return { resulting, conversationIds };
}
