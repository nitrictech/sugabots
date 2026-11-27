import type { ChatDetails } from "@sugabots/contracts";
import { useSetResolved } from "@/lib/chats.ts";
import type { ResolvedToggle } from "./ChatHeader.tsx";

/**
 * Whether the chat, when it is a project's chat, is resolved, and how to
 * mark it resolved or reopen it, when `mayResolve` says the member may; and
 * whether that last failed to save. Only a project's chat is ever resolved, a
 * bot's included: not an automation's feed.
 */
export function useChatResolved(
	chatId: string,
	details: ChatDetails | undefined,
	mayResolve: boolean,
): { resolved: ResolvedToggle | undefined; failed: boolean } {
	const setResolved = useSetResolved(chatId);
	const resolved =
		details?.chat.kind === "project_chat"
			? {
					isResolved: details.chat.resolvedAt !== null,
					onChange: mayResolve
						? (to: boolean) =>
								setResolved.mutateAsync(to).then(
									() => true,
									() => false,
								)
						: undefined,
				}
			: undefined;
	return { resolved, failed: setResolved.isError };
}
