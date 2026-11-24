import type { ChatMessageItem, Message } from "@sugabots/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ownerLinkOptions, type ResourceOwner } from "@/lib/resource-owner.tsx";
import { messagesIn } from "./chat-items.ts";

/**
 * Opens an automation's run from its row in a chat: its automation's page
 * opens in the chat's place, unless the chat is that automation's feed
 * already.
 */
export function useRunOpening({
	items,
	owner,
	feedOfAutomationId,
}: {
	items: readonly ChatMessageItem[];
	/** Whose the chat is, a bot or a project, whose automation a run opens. */
	owner: ResourceOwner;
	/** The automation whose feed the chat is, when it is one. */
	feedOfAutomationId: string | undefined;
}): (runChatId: string) => void {
	const navigate = useNavigate();
	const resulting = runsResultingIn(items);
	return (runChatId) => {
		const run = resulting.get(runChatId);
		if (!run || run.automationId === feedOfAutomationId) return;
		void navigate(ownerLinkOptions(owner, { page: "automation", automationId: run.automationId }));
	};
}

type RunResulting = NonNullable<Message["automationResultOf"]>;

/** The automation runs whose results are among `items`' messages, by the run's chat. */
function runsResultingIn(items: readonly ChatMessageItem[]): ReadonlyMap<string, RunResulting> {
	return new Map(
		messagesIn(items).flatMap((message) =>
			message.automationResultOf
				? [[message.automationResultOf.chatId, message.automationResultOf] as const]
				: [],
		),
	);
}
