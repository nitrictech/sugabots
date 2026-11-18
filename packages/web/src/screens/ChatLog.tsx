import { cn } from "cn";
import type { ReactNode, Ref } from "react";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import type { ChatLogPosition } from "./chat-log-position.ts";

/**
 * The scrolling log of a chat's messages, anchored to its foot, so a short
 * chat sits just above the composer. Above `children`, a way to load older
 * messages while there are any, and `intro` once there are none.
 */
export function ChatLog({
	position,
	messages,
	intro,
	columnRef,
	centred = false,
	underHeader = false,
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
	/** The top of the conversation, shown once there is nothing older to load. */
	intro: ReactNode;
	/** The column the messages are in, which a header over them is measured against. */
	columnRef?: Ref<HTMLDivElement>;
	/** A centred column of reading width, as a bot's task has, rather than the whole width. */
	centred?: boolean;
	/** Whether the header sits over the log from a tablet up, so the first message starts clear of it. */
	underHeader?: boolean;
	children: ReactNode;
}) {
	return (
		<div
			ref={position.attachViewport}
			role="log"
			aria-label="Chat messages"
			onScroll={position.onScroll}
			className={cn(
				"min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-3 pb-4 max-md:pt-safe-offset-16",
				underHeader && "md:pt-16",
			)}
		>
			<div
				ref={columnRef}
				className={cn(
					"flex min-h-full w-full flex-col justify-end",
					centred && "mx-auto max-w-200",
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
		</div>
	);
}
