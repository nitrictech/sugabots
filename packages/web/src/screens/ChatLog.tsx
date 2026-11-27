import { cn } from "cn";
import type { ReactNode, Ref } from "react";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import type { ChatLogPosition } from "./chat-log-position.ts";

/**
 * The scrolling log of a chat's messages, in a centred column of reading
 * width, anchored to its foot, so a short chat sits just above `footer`.
 * Above `children`, a way to load older messages while there are any, and
 * `intro` once there are none.
 */
export function ChatLog({
	position,
	messages,
	intro,
	columnRef,
	underHeader = false,
	footer,
	children,
}: {
	position: Pick<ChatLogPosition, "attachViewport" | "onScroll" | "settledAtLatest" | "loadOlder">;
	/** How loading the chat's pages of messages stands. */
	messages: {
		isError: boolean;
		isSuccess: boolean;
		hasNextPage: boolean;
		isFetchingNextPage: boolean;
	};
	/** The top of the chat, shown once there is nothing older to load. */
	intro: ReactNode;
	/** The column the messages are in, which a header over them is measured against. */
	columnRef?: Ref<HTMLDivElement>;
	/** Whether the header sits over the log from a tablet up, so the first message starts clear of it. */
	underHeader?: boolean;
	/**
	 * What stays at the foot of the log, such as the composer, with no
	 * background of its own: the messages scroll on under it.
	 */
	footer?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div
			ref={position.attachViewport}
			onScroll={position.onScroll}
			className={cn(
				"flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto pt-3 max-md:pt-safe-offset-16",
				underHeader && "md:pt-16",
			)}
		>
			<div
				ref={columnRef}
				role="log"
				aria-label="Chat messages"
				className={cn(
					// Fills what the footer leaves, so a short chat needs no scrolling.
					"mx-auto flex w-full max-w-3xl shrink-0 grow flex-col justify-end pb-4",
					!position.settledAtLatest && "max-md:invisible",
				)}
			>
				{messages.isError && (
					<div className="px-5">
						<Alert>Messages could not be loaded. Reload this page to try again.</Alert>
					</div>
				)}
				{messages.hasNextPage && (
					<Button
						variant="link"
						size="bare"
						className="self-center"
						disabled={messages.isFetchingNextPage}
						onClick={() => void position.loadOlder()}
					>
						{messages.isFetchingNextPage ? "Loading…" : "Load older messages"}
					</Button>
				)}
				{messages.isSuccess && !messages.hasNextPage && intro}
				{children}
			</div>
			{footer && <div className="sticky bottom-0 z-10 shrink-0">{footer}</div>}
		</div>
	);
}
