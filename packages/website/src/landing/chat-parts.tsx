import { cn } from "cn";
import type { ReactNode } from "react";
import { type ChatAuthor, ChatMessage, ChatText } from "@/components/chat";

interface MessageRowProps {
	author: ChatAuthor;
	time: string;
	text: string;
	/** What hangs under the text, such as a reaction. */
	children?: ReactNode;
	className?: string;
}

/** One message as the app shows it, in the landing page's palette. */
export function MessageRow({ author, time, text, children, className }: MessageRowProps) {
	return (
		<ChatMessage
			author={author}
			avatarSize="sm"
			time={time}
			className={cn("landing-chat-colours", className)}
		>
			<ChatText>{text}</ChatText>
			{children}
		</ChatMessage>
	);
}

/** How a message arrives in a demo: a short fade and rise. */
export const arrive =
	"animate-in fade-in slide-in-from-bottom-2 duration-260 ease-landing motion-reduce:animate-none";
