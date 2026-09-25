import { type BotColor, botColors } from "@sugabots/avatars";
import { cva } from "class-variance-authority";
import { cn } from "cn";
import type { ComponentProps, ReactNode } from "react";

type Side = "start" | "end";

const chatMessage = cva("flex items-end gap-2", {
	variants: {
		side: { start: "justify-start", end: "flex-row-reverse" },
	},
});

interface ChatMessageProps {
	side: Side;
	/** Who sent it. Omitted for your own messages. */
	avatar?: ReactNode;
	children: ReactNode;
}

/** One sender's turn: their avatar beside a stack of bubbles. */
export function ChatMessage({ side, avatar, children }: ChatMessageProps) {
	return (
		<div className={chatMessage({ side })}>
			{avatar}
			<div
				className={cn(
					"flex min-w-0 flex-col gap-1",
					side === "start" ? "items-start" : "items-end",
				)}
			>
				{children}
			</div>
		</div>
	);
}

/** A person, you, or a bot wearing one of the palette colours. */
export type ChatTone = "person" | "self" | BotColor;

const chatBubble = cva("max-w-md rounded-3xl px-4 py-2.5 text-pretty", {
	variants: {
		side: { start: "rounded-bl-md", end: "rounded-br-md" },
		size: { default: "text-base", sm: "text-sm" },
	},
	defaultVariants: { size: "default" },
});

function toneClasses(tone: ChatTone) {
	if (tone === "person") return "bg-secondary text-secondary-foreground";
	if (tone === "self") return "bg-brand text-brand-foreground";
	return botColors[tone].tint;
}

interface ChatBubbleProps extends ComponentProps<"p"> {
	tone: ChatTone;
	/** The side it hangs from; its tail corner points back at the sender. */
	side: Side;
	size?: "default" | "sm";
}

export function ChatBubble({ tone, side, size, className, ...props }: ChatBubbleProps) {
	return <p className={cn(chatBubble({ side, size }), toneClasses(tone), className)} {...props} />;
}

/** A centred aside in the conversation: a timestamp, who is talking. */
export function ChatNote({ className, ...props }: ComponentProps<"p">) {
	return (
		<p
			className={cn("text-center text-xs font-semibold text-muted-foreground", className)}
			{...props}
		/>
	);
}
