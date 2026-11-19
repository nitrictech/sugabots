import { cn } from "cn";
import type { ReactNode } from "react";
import { type ChatAuthor, ChatMessage, ChatText } from "@/components/chat";

/** The docs' chat tokens set to the landing page's palette, so `ChatMessage` draws in it. */
const landingChatColours =
	"text-landing-text [--border:var(--color-landing-line)] [--muted-foreground:var(--color-landing-muted)] [--muted:var(--color-landing-chip)] [--secondary-foreground:var(--color-landing-secondary)] [--secondary:var(--color-landing-button)]";

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
			className={cn(landingChatColours, className)}
		>
			<ChatText>{text}</ChatText>
			{children}
		</ChatMessage>
	);
}

/** How a message arrives in a demo: a short fade and rise. */
export const arrive =
	"animate-in fade-in slide-in-from-bottom-1.5 duration-260 ease-landing motion-reduce:animate-none";
