import type { CurrentUser } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { MessageSquareOff } from "lucide-react";
import { type ReactNode, Suspense } from "react";
import type { ChatLocation } from "@/lib/chats.ts";
import { matchesMedia, SIDE_BY_SIDE } from "@/lib/media.ts";
import { ownerLinkOptions } from "@/lib/resource-owner.tsx";
import { useSession } from "@/lib/session.ts";
import { backToOwner } from "@/screens/ChatHeader.tsx";
import type { StagedChange } from "@/screens/staged.ts";
import { buttonStyles } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { lazyNamed } from "./lazy-screen.tsx";
import { type ChatSearch, stagedOf, stagedSearchOf } from "./search.ts";

export const ChatPage = lazyNamed(() => import("@/screens/ChatPage.tsx"), "ChatPage");
const NestedChatPage = lazyNamed(() => import("@/screens/NestedChatPage.tsx"), "NestedChatPage");

/**
 * Where a page opens its chat beside the sidebar. On a phone, touching
 * a chat's link preloads it instead, through the chat route's
 * loader.
 */
export function preloadChatScreenForWideLayout() {
	if (matchesMedia(SIDE_BY_SIDE)) ChatPage.preload();
}

/** What a chat's address says to open beside it, and how a page changes it. */
export type SearchChange = {
	search: (previous: ChatSearch) => ChatSearch;
	replace?: boolean;
};

/**
 * A chat at its own address, in a project or a bot's, keeping what
 * the address opens beside it in step with the page.
 */
export function RoutedChat({
	found,
	chatId,
	signedIn,
	search,
	navigate,
}: {
	found: ChatLocation;
	chatId: string;
	signedIn: CurrentUser;
	search: ChatSearch;
	navigate: (change: SearchChange) => void;
}) {
	const searchProps = useChatSearchProps(search, navigate);
	// A run a notification names is the page itself, with the way back to where it is.
	if (search.nestedChatPage) {
		return (
			<NestedChatPage
				chatLocation={found}
				chatId={chatId}
				nestedChatId={search.nestedChatPage}
				back={backToOwner(found)}
				trailing={
					<Link
						{...ownerLinkOptions(found, { page: "chat", chatId })}
						className={cn(
							buttonStyles({ variant: "secondary", size: "sm" }),
							"shrink-0 max-md:hidden",
						)}
					>
						Open chat
					</Link>
				}
			/>
		);
	}
	return <ChatPage chatLocation={found} chatId={chatId} signedIn={signedIn} {...searchProps} />;
}

/**
 * What a chat's address keeps open with it, as its page's props: the
 * message jumped to and what is open large, changed through `navigate`.
 */
function useChatSearchProps(search: ChatSearch, navigate: (change: SearchChange) => void) {
	const onStagedChange: StagedChange = (staged, how) =>
		navigate({ search: (previous) => ({ ...previous, ...stagedSearchOf(staged) }), ...how });
	return {
		focusMessageId: search.message,
		staged: stagedOf(search),
		onStagedChange,
	};
}

/**
 * A screen of a chat, once `place` has found where it is and who it
 * is with; while it loads nothing, and if it cannot be found, why.
 */
export function ChatScreen<Place>({
	place: { found, isPending, error },
	children,
}: {
	place: { found: Place | undefined; isPending: boolean; error: unknown };
	children: (found: Place, signedIn: CurrentUser) => ReactNode;
}) {
	const { member: signedIn } = useSession();

	if (isPending) return null;
	if (!found) {
		return (
			// Lifted a little above the middle, as a project's empty pages are.
			<div className="flex min-h-0 flex-1 pb-20">
				<EmptyState
					title={error ? "Could not load this chat" : "Chat not found"}
					icon={<MessageSquareOff strokeWidth={1.75} />}
				>
					{error
						? "Reload the page, or check that the API is running."
						: "It was removed, or you're not in it."}
				</EmptyState>
			</div>
		);
	}
	if (!signedIn) return null;
	return (
		// The screen's code can arrive after its data. Without a boundary of its
		// own, React would hide the sidebar with it while it loads.
		<Suspense fallback={null}>{children(found, signedIn)}</Suspense>
	);
}
