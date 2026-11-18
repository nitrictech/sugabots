import { createRoute, Outlet } from "@tanstack/react-router";
import { prefetchConversation, useAnyConversationPlace } from "@/lib/chats.ts";
import { Inbox, InboxOverview } from "@/shell/Inbox.tsx";
import { Panes } from "@/shell/Shell.tsx";
import {
	ConversationPage,
	ConversationScreen,
	useConversationSearchProps,
} from "./conversation.tsx";
import { lazyNamed } from "./lazy-screen.tsx";
import { type ConversationSearch, validateConversationSearch } from "./search.ts";
import { shellRoute } from "./workspace.tsx";

const InboxPane = lazyNamed(
	() => import("@/screens/InboxPane.tsx").then(({ InboxPane }) => ({ InboxPane })),
	"InboxPane",
);

/** Inbox: what is new across the workspace, and the chat, run or collaboration of each, opened in its place. */
export const inboxRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/inbox",
	component: () => (
		<Panes>
			<Inbox>
				<Outlet />
			</Inbox>
		</Panes>
	),
});

/** With nothing chosen, how much is unread sits beside the list; on a phone the list is the page. */
export const inboxIndexRoute = createRoute({
	getParentRoute: () => inboxRoute,
	path: "/",
	component: InboxOverview,
});

type InboxConversationSearch = ConversationSearch;

export const inboxConversationRoute = createRoute({
	getParentRoute: () => inboxRoute,
	path: "/$conversation",
	validateSearch: (search: Record<string, unknown>): InboxConversationSearch =>
		validateConversationSearch(search),
	preloadStaleTime: 0,
	loader: ({ context, params }) => {
		prefetchConversation(context.queries, params.conversation);
		return ConversationPage.preload();
	},
	component: () => {
		const { conversation } = inboxConversationRoute.useParams();
		const navigate = inboxConversationRoute.useNavigate();
		const search = inboxConversationRoute.useSearch();
		const searchProps = useConversationSearchProps(search, (change) => void navigate(change));
		return (
			<ConversationScreen place={useAnyConversationPlace(conversation)}>
				{(found, user) => (
					<InboxPane
						channel={found.channel}
						conversation={found.conversation}
						conversationId={conversation}
						user={user}
						itemPageId={search.itemPage}
						onItemPageChange={(itemPage) =>
							void navigate({ search: (previous) => ({ ...previous, itemPage }) })
						}
						{...searchProps}
					/>
				)}
			</ConversationScreen>
		);
	},
});
