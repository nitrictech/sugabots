import type { Channel } from "@sugabots/contracts";
import { createRoute, Navigate, Outlet } from "@tanstack/react-router";
import { findChannel, useChannels, useJoinChannel } from "@/lib/channels.ts";
import {
	prefetchConversation,
	useChannelConversationPlace,
	useOpenChannelConversation,
} from "@/lib/chats.ts";
import { failureMessage } from "@/lib/failure.ts";
import { conversationLink } from "@/lib/links.ts";
import { FilesPage } from "@/screens/Files.tsx";
import { ChannelsDirectory } from "@/shell/ChannelsDirectory.tsx";
import { Panes } from "@/shell/Shell.tsx";
import { Button } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import {
	API_DID_NOT_ANSWER,
	ConversationPage,
	ConversationScreen,
	preloadChatScreenForWideLayout,
	RoutedConversation,
} from "./conversation.tsx";
import { validateConversationSearch, validateFileSearch } from "./search.ts";
import { shellRoute } from "./workspace.tsx";

/** Every channel the person is in or could join, and making another. */
export const channelsRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/channels",
	component: () => (
		<Panes>
			<ChannelsDirectory />
		</Panes>
	),
});

export const channelRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/channels/$channel",
	loader: preloadChatScreenForWideLayout,
	component: ChannelRoute,
});

/** A channel's page beside the sidebar. */
function ChannelRoute() {
	const { channel: slug } = channelRoute.useParams();
	const { data: channels, isPending, error } = useChannels();
	const channel = findChannel(channels, slug);
	if (isPending) return <Panes>{null}</Panes>;
	if (!channel) {
		return (
			<Panes>
				<EmptyState title={error ? "Could not load this channel" : "No such channel here"}>
					{error
						? "The API did not answer. Reload, or check that it is running."
						: "It may have been removed, or it is private and you're not in it."}
				</EmptyState>
			</Panes>
		);
	}
	// A public channel the person isn't in, opened by its address: what it is, and Join.
	if (!channel.isMember) {
		return (
			<Panes>
				<JoinChannel channel={channel} />
			</Panes>
		);
	}
	return (
		<Panes>
			<Outlet />
		</Panes>
	);
}

/** A channel the person isn't in: its name and what it's for, with Join where they may. */
function JoinChannel({ channel }: { channel: Channel }) {
	const join = useJoinChannel();
	return (
		<EmptyState title={channel.name}>
			<span className="flex flex-col items-center gap-3">
				<span>{channel.description ?? "You're not in this channel yet."}</span>
				{channel.permissions.join ? (
					<Button disabled={join.isPending} onClick={() => join.mutate(channel.id)}>
						Join {channel.name}
					</Button>
				) : (
					<span>Ask someone in it to add you.</span>
				)}
				{join.isError && <span role="alert">{failureMessage(join.error)}</span>}
			</span>
		</EmptyState>
	);
}

/** A channel opened without a conversation chosen opens its main chat, opened first if nobody has. */
export const channelIndexRoute = createRoute({
	getParentRoute: () => channelRoute,
	path: "/",
	loader: () => ConversationPage.preload(),
	component: () => {
		const channel = findChannel(useChannels().data, channelIndexRoute.useParams().channel);
		return channel ? <OpenChannelConversation channel={channel} /> : null;
	},
});

function OpenChannelConversation({ channel }: { channel: Channel }) {
	const opened = useOpenChannelConversation(channel);
	if (opened.isError) {
		return <EmptyState title="Could not open this channel">{API_DID_NOT_ANSWER}</EmptyState>;
	}
	if (!opened.data) return null;
	return <Navigate {...conversationLink({ channel, conversationId: opened.data.id })} replace />;
}

export const channelFilesRoute = createRoute({
	getParentRoute: () => channelRoute,
	path: "/files",
	component: () => {
		const channel = findChannel(useChannels().data, channelFilesRoute.useParams().channel);
		return channel ? <FilesPage owner={{ channel }} /> : null;
	},
});

export const channelFileRoute = createRoute({
	getParentRoute: () => channelRoute,
	path: "/files/$file",
	validateSearch: (search: Record<string, unknown>) => validateFileSearch(search),
	component: () => {
		const { channel: slug, file } = channelFileRoute.useParams();
		const { version } = channelFileRoute.useSearch();
		const channel = findChannel(useChannels().data, slug);
		return channel ? <FilesPage owner={{ channel }} selectedId={file} version={version} /> : null;
	},
});

/** A channel's main chat or one of its threads. */
export const channelConversationRoute = createRoute({
	getParentRoute: () => channelRoute,
	path: "/$conversation",
	validateSearch: (search: Record<string, unknown>) => validateConversationSearch(search),
	// On every hover, not once per 30 s: the query cache, not the router,
	// decides what of the conversation is still fresh.
	preloadStaleTime: 0,
	// Also run while the pointer is on a link here, so it is loading before the click.
	loader: ({ context, params }) => {
		prefetchConversation(context.queries, params.conversation);
		return ConversationPage.preload();
	},
	component: () => {
		const { channel, conversation } = channelConversationRoute.useParams();
		const navigate = channelConversationRoute.useNavigate();
		const search = channelConversationRoute.useSearch();
		return (
			<ConversationScreen place={useChannelConversationPlace(channel, conversation)}>
				{(found, user) => (
					<RoutedConversation
						found={found}
						conversationId={conversation}
						user={user}
						search={search}
						navigate={(change) => void navigate(change)}
					/>
				)}
			</ConversationScreen>
		);
	},
});
