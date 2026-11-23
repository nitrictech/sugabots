import { useQuery } from "@tanstack/react-query";
import { chatQuery } from "./chat-query.ts";
import { BROWSER_TOOL_PREFIX } from "./tool-names.ts";

/**
 * Whether the bot is using its desktop in the chat right now: its reply
 * is still being written and has called a browser tool. Read from the chat
 * the chat has loaded and its events keep current, so it asks the API for
 * nothing of its own.
 */
export function useDesktopInUse(chatId: string | undefined, botId: string): boolean {
	const { data } = useQuery({ ...chatQuery(chatId), enabled: false });
	const reply = data?.messages.findLast(
		(message) => message.author.kind === "bot" && message.author.id === botId,
	);
	return (
		reply?.status === "writing" &&
		reply.parts.some(
			(part) => part.type === "tool_call" && part.tool.startsWith(BROWSER_TOOL_PREFIX),
		)
	);
}
