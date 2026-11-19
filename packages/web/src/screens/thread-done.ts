import type { ConversationDetails } from "@sugabots/contracts";
import { useSetDone } from "@/lib/chats.ts";
import type { DoneToggle } from "./ChatHeader.tsx";

/**
 * Whether the conversation, when it is a thread, is done, and how to mark it
 * done or reopen it; and whether that last failed to save. Only a thread is
 * ever done, a bot's or a project's: not an automation's feed.
 */
export function useThreadDone(
	conversationId: string,
	details: ConversationDetails | undefined,
): { done: DoneToggle | undefined; failed: boolean } {
	const setDone = useSetDone(conversationId);
	const done =
		details?.conversation.kind === "project_thread"
			? {
					isDone: details.conversation.doneAt !== null,
					onChange: (to: boolean) =>
						setDone.mutateAsync(to).then(
							() => true,
							() => false,
						),
				}
			: undefined;
	return { done, failed: setDone.isError };
}
