import { createRoute, Outlet, useMatchRoute } from "@tanstack/react-router";
import { prefetchConversation, useDirectMessage } from "@/lib/chats.ts";
import { DirectMessagesOverview } from "@/shell/DirectMessages.tsx";
import { MobileDirectMessages } from "@/shell/MobileHome.tsx";
import { Panes } from "@/shell/Shell.tsx";
import {
	ConversationPage,
	ConversationScreen,
	useConversationSearchProps,
} from "./conversation.tsx";
import { lazyNamed } from "./lazy-screen.tsx";
import { type ConversationSearch, idParam, validateConversationSearch } from "./search.ts";
import { shellRoute } from "./workspace.tsx";

// Lazy as the conversation is: it shows the one there already is with the people chosen.
const NewDirectMessagePage = lazyNamed(
	() => import("@/shell/NewDirectMessage.tsx"),
	"NewDirectMessagePage",
);

/**
 * Your direct messages with other people. The address names no channel, as a
 * direct message between people is in none. On a phone the list is the page
 * until one is open.
 */
export const directMessagesRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/dm",
	component: DirectMessagesRoute,
});

function DirectMessagesRoute() {
	const matchRoute = useMatchRoute();
	const atList = Boolean(matchRoute({ to: directMessagesRoute.fullPath }));
	return (
		<>
			{atList && <MobileDirectMessages className="md:hidden" />}
			<Panes className={atList ? "max-md:hidden" : undefined}>
				<Outlet />
			</Panes>
		</>
	);
}

/** Beside the sidebar while none is open: a way to start one. */
export const directMessagesIndexRoute = createRoute({
	getParentRoute: () => directMessagesRoute,
	path: "/",
	component: DirectMessagesOverview,
});

/** Starting a direct message: whom to, and the first message. */
export const newDirectMessageRoute = createRoute({
	getParentRoute: () => directMessagesRoute,
	path: "/new",
	component: () => <NewDirectMessagePage />,
});

interface DirectMessageSearch extends ConversationSearch {
	/** A message to jump to, such as the one a notification is about. */
	message?: string;
}

export const directMessageRoute = createRoute({
	getParentRoute: () => directMessagesRoute,
	path: "/$conversation",
	validateSearch: (search: Record<string, unknown>): DirectMessageSearch => ({
		...validateConversationSearch(search),
		...idParam(search, "message"),
	}),
	preloadStaleTime: 0,
	loader: ({ context, params }) => {
		prefetchConversation(context.queries, params.conversation);
		return ConversationPage.preload();
	},
	component: () => {
		const { conversation } = directMessageRoute.useParams();
		const navigate = directMessageRoute.useNavigate();
		const search = directMessageRoute.useSearch();
		const searchProps = useConversationSearchProps(search, (change) => void navigate(change));
		return (
			<ConversationScreen place={useDirectMessage(conversation)}>
				{(found, user) => (
					<ConversationPage
						conversation={found.conversation}
						channel={found.channel}
						conversationId={conversation}
						user={user}
						{...searchProps}
					/>
				)}
			</ConversationScreen>
		);
	},
});
