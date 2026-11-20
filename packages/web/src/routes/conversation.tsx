import type { SessionUser } from "@sugabots/contracts";
import { Link, useLocation } from "@tanstack/react-router";
import { cn } from "cn";
import { MessageSquareOff } from "lucide-react";
import { type ReactNode, Suspense } from "react";
import type { ConversationPlace } from "@/lib/chats.ts";
import { matchesMedia, SIDE_BY_SIDE } from "@/lib/media.ts";
import { ownerLinkOptions } from "@/lib/resource-owner.tsx";
import { useSession } from "@/lib/session.ts";
import { backToOwner } from "@/screens/ChatHeader.tsx";
import type { StagedChange } from "@/screens/staged.ts";
import { useLeave } from "@/ui/back-button.tsx";
import { buttonStyles } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { lazyNamed } from "./lazy-screen.tsx";
import { type ConversationSearch, stagedOf, stagedSearchOf } from "./search.ts";

export const ConversationPage = lazyNamed(
	() => import("@/screens/ConversationPage.tsx"),
	"ConversationPage",
);
const ItemConversationPage = lazyNamed(
	() =>
		import("@/screens/InboxPane.tsx").then(({ ItemConversationPage }) => ({
			ItemConversationPage,
		})),
	"ItemConversationPage",
);

/**
 * Where a page opens its conversation beside the sidebar. On a phone, touching
 * a conversation's link preloads it instead, through the conversation route's
 * loader.
 */
export function preloadChatScreenForWideLayout() {
	if (matchesMedia(SIDE_BY_SIDE)) ConversationPage.preload();
}

export const API_DID_NOT_ANSWER = "The API did not answer. Reload this page to try again.";

/** What a conversation's address says to open beside it, and how a page changes it. */
export type SearchChange = {
	search: (previous: ConversationSearch) => ConversationSearch;
	replace?: boolean;
};

/**
 * A conversation at its own address, in a project or a bot's, keeping what
 * the address opens beside it in step with the page.
 */
export function RoutedConversation({
	found,
	conversationId,
	user,
	search,
	navigate,
}: {
	found: ConversationPlace;
	conversationId: string;
	user: SessionUser;
	search: ConversationSearch;
	navigate: (change: SearchChange) => void;
}) {
	const searchProps = useConversationSearchProps(search, navigate);
	// A run or collaboration a notification names is the page itself, with the way back to where it is.
	if (search.itemPage) {
		return (
			<ItemConversationPage
				conversationPlace={found}
				conversationId={conversationId}
				itemConversationId={search.itemPage}
				back={backToOwner(found)}
				trailing={
					<Link
						{...ownerLinkOptions(found, { page: "thread", conversationId })}
						className={cn(
							buttonStyles({ variant: "secondary", size: "sm" }),
							"shrink-0 max-md:hidden",
						)}
					>
						Open conversation
					</Link>
				}
				onOpenItem={(itemPage) => navigate({ search: (previous) => ({ ...previous, itemPage }) })}
			/>
		);
	}
	return (
		<ConversationPage
			conversationPlace={found}
			conversationId={conversationId}
			user={user}
			{...searchProps}
		/>
	);
}

/**
 * What a conversation's address keeps open with it, as its page's props: the
 * item beside it, the message jumped to and what is open large, each changed
 * through `navigate`.
 */
export function useConversationSearchProps(
	search: ConversationSearch,
	navigate: (change: SearchChange) => void,
) {
	const onItemChange = useItemChange((item, replace) =>
		navigate({ search: (previous) => ({ ...previous, item }), replace }),
	);
	const onStagedChange: StagedChange = (staged, how) =>
		navigate({ search: (previous) => ({ ...previous, ...stagedSearchOf(staged) }), ...how });
	return {
		itemConversationId: search.item,
		focusMessageId: search.message,
		onItemChange,
		staged: stagedOf(search),
		onStagedChange,
	};
}

/**
 * A screen of a conversation, once `place` has found where it is and who it
 * is with; while it loads nothing, and if it cannot be found, why.
 */
export function ConversationScreen<Place>({
	place: { found, isPending, error },
	children,
}: {
	place: { found: Place | undefined; isPending: boolean; error: unknown };
	children: (found: Place, user: SessionUser) => ReactNode;
}) {
	const { user } = useSession();

	if (isPending) return null;
	if (!found) {
		return (
			// Lifted a little above the middle, as a project's empty pages are.
			<div className="flex min-h-0 flex-1 pb-20">
				<EmptyState
					title={error ? "Could not load this conversation" : "Conversation not found"}
					icon={<MessageSquareOff strokeWidth={1.75} />}
				>
					{error
						? "Reload the page, or check that the API is running."
						: "It was removed, or you're not in it."}
				</EmptyState>
			</div>
		);
	}
	if (!user) return null;
	return (
		// The screen's code can arrive after its data. Without a boundary of its
		// own, React would hide the sidebar with it while it loads.
		<Suspense fallback={null}>{children(found, user)}</Suspense>
	);
}

/**
 * Opens a run or collaboration over its conversation, or closes it, with `go`,
 * which names it in the address. On a phone an item covers its conversation
 * as a page of its own, so closing one shows the conversation: back to it
 * when that is the page behind, else the conversation in the item's place, as
 * when the item was opened from Inbox. Opening the conversation as a page
 * after the item would have its own Back return to the item.
 */
function useItemChange(go: (item: string | undefined, replace: boolean) => void) {
	const { leaveFor } = useLeave();
	const { pathname } = useLocation();
	return (item: string | undefined) => {
		if (item !== undefined || matchesMedia(SIDE_BY_SIDE)) {
			go(item, false);
			return;
		}
		leaveFor(
			(page) => page.pathname === pathname && page.search.item === undefined,
			() => go(undefined, true),
		);
	};
}
