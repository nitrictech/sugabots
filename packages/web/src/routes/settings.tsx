import type { Bot, Channel } from "@sugabots/contracts";
import { createRoute, Navigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { useBotWithHandle } from "@/lib/bots.ts";
import { findChannel, useChannels } from "@/lib/channels.ts";
import { signInFailureReason } from "@/lib/connections.ts";
import { botSettingsLink, channelSettingsLink } from "@/lib/links.ts";
import {
	botSettingsPage,
	channelSettingsPage,
	workspaceSettingSection,
} from "@/lib/workspace-settings.ts";
import { SettingsLayout } from "@/screens/SettingsLayout.tsx";
import { Panes } from "@/shell/Shell.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { lazyNamed } from "./lazy-screen.tsx";
import { optionalString } from "./search.ts";
import { shellRoute } from "./workspace.tsx";

/*
 * The settings sections are a chunk of their own; the window they open in is
 * not. `SettingsDialog` is imported eagerly so the click opens something, and
 * its `Suspense` holds the space the sections land in.
 */
const WorkspaceSettings = lazyNamed(
	() => import("@/screens/WorkspaceSettings.tsx"),
	"WorkspaceSettings",
);

export const settingsRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings",
	// General on a wide screen; on a phone, the list of sections to drill into.
	component: () => (
		<SettingsLayout index>
			<WorkspaceSettings section="general" />
		</SettingsLayout>
	),
});

export const settingsSectionRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/$section",
	component: SettingsSectionRoute,
});

/** One person in the workspace, by their membership's id. */
export const settingsMemberRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/members/$member",
	loader: () => WorkspaceSettings.preload(),
	component: SettingsMemberRoute,
});

function SettingsMemberRoute() {
	const { member } = settingsMemberRoute.useParams();
	return (
		<SettingsLayout>
			<WorkspaceSettings section="members" selectedMemberId={member} />
		</SettingsLayout>
	);
}

export const settingsChannelRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/channels/$channel",
	// The dialog waits for the rosters, so its code downloads alongside rather than after.
	loader: () => WorkspaceSettings.preload(),
	component: SettingsChannelRoute,
});

/** One of a channel's pages besides General: People or Bots. */
export const settingsChannelPageRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/channels/$channel/$page",
	loader: () => WorkspaceSettings.preload(),
	component: SettingsChannelPageRoute,
});

export const settingsBotRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/bots/$bot",
	loader: () => WorkspaceSettings.preload(),
	component: SettingsBotRoute,
});

/** One of a bot's pages besides its own: Connections or Computer. */
export const settingsBotPageRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/bots/$bot/$page",
	validateSearch: (search: Record<string, unknown>): { oauth_error?: string } => ({
		oauth_error: optionalString(search.oauth_error),
	}),
	// A sign-in error shown for one bot must not follow you to the next.
	remountDeps: ({ params }) => [params.workspace, params.bot],
	loader: () => WorkspaceSettings.preload(),
	component: SettingsBotPageRoute,
});

/** One of a bot's connections, by its id. */
export const settingsBotConnectionRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/bots/$bot/connections/$connection",
	loader: () => WorkspaceSettings.preload(),
	component: SettingsBotConnectionRoute,
});

/** One model provider, by its id. */
export const settingsProviderRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/providers/$provider",
	loader: () => WorkspaceSettings.preload(),
	component: SettingsProviderRoute,
});

function SettingsProviderRoute() {
	const { provider } = settingsProviderRoute.useParams();
	return (
		<SettingsLayout>
			<WorkspaceSettings section="providers" selectedProviderId={provider} />
		</SettingsLayout>
	);
}

/** The one model the system bots share. A fixed path, which wins over a provider's id. */
export const settingsSystemModelRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/providers/system",
	loader: () => WorkspaceSettings.preload(),
	component: () => (
		<SettingsLayout>
			<WorkspaceSettings section="providers" modelChoice="system" />
		</SettingsLayout>
	),
});

/** The model new bots start on. A fixed path, like the system bots' one. */
export const settingsDefaultModelRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/providers/default",
	loader: () => WorkspaceSettings.preload(),
	component: () => (
		<SettingsLayout>
			<WorkspaceSettings section="providers" modelChoice="default" />
		</SettingsLayout>
	),
});

function SettingsChannelRoute() {
	const { channel: slug } = settingsChannelRoute.useParams();
	const { data: channels, isPending, error } = useChannels();
	// A channel's settings are for the people in it.
	const channel = memberChannel(channels, slug);
	if (isPending) return <SettingsLayout>{null}</SettingsLayout>;
	if (!channel) return <ChannelSettingsMissing channels={channels} slug={slug} error={error} />;
	return (
		<SettingsLayout>
			<WorkspaceSettings section="channels" selectedChannelId={channel.id} />
		</SettingsLayout>
	);
}

function SettingsChannelPageRoute() {
	const { channel: slug, page: pageSegment } = settingsChannelPageRoute.useParams();
	const { data: channels, isPending, error } = useChannels();
	const channel = memberChannel(channels, slug);
	const page = channelSettingsPage(pageSegment);
	if (!page) {
		return <Navigate {...channelSettingsLink({ slug })} replace />;
	}
	if (isPending) return <SettingsLayout>{null}</SettingsLayout>;
	if (!channel) return <ChannelSettingsMissing channels={channels} slug={slug} error={error} />;
	return (
		<SettingsLayout>
			<WorkspaceSettings section="channels" selectedChannelId={channel.id} channelPage={page} />
		</SettingsLayout>
	);
}

/**
 * Why a channel's settings are not shown: it could not be loaded, it is not
 * here, or the person is not in it, which a public channel's own page joins.
 */
function ChannelSettingsMissing({
	channels,
	slug,
	error,
}: {
	channels: readonly Channel[] | undefined;
	slug: string;
	error: unknown;
}) {
	const channel = findChannel(channels, slug);
	return (
		<Panes>
			{channel ? (
				<EmptyState title="You're not in this channel">
					Join it from its page to see its settings.
				</EmptyState>
			) : (
				<EmptyState title={error ? "Could not load this channel" : "No such channel here"} />
			)}
		</Panes>
	);
}

/** The channel at `slug` when the person is in it, as its settings need. */
function memberChannel(
	channels: readonly Channel[] | undefined,
	slug: string,
): Channel | undefined {
	const channel = findChannel(channels, slug);
	return channel?.isMember ? channel : undefined;
}

/** The bot at `handle` for a settings page, once found; while it loads nothing, and if missing, why. */
function SettingsBot({ handle, children }: { handle: string; children: (bot: Bot) => ReactNode }) {
	const { bot, isPending, error } = useBotWithHandle(handle);
	if (isPending) return <SettingsLayout>{null}</SettingsLayout>;
	if (!bot) {
		return (
			<Panes>
				<EmptyState title={error ? "Could not load this bot" : "No such bot here"} />
			</Panes>
		);
	}
	return <SettingsLayout>{children(bot)}</SettingsLayout>;
}

function SettingsBotRoute() {
	const { bot } = settingsBotRoute.useParams();
	return (
		<SettingsBot handle={bot}>
			{(bot) => <WorkspaceSettings section="bots" selectedBot={bot} />}
		</SettingsBot>
	);
}

function SettingsBotPageRoute() {
	const { bot, page: pageSegment } = settingsBotPageRoute.useParams();
	const { oauth_error: oauthError } = settingsBotPageRoute.useSearch();
	const navigate = settingsBotPageRoute.useNavigate();
	// Kept after the error leaves the address, so a reload does not show it twice.
	const [signInError, setSignInError] = useState(oauthError);
	useEffect(() => {
		if (oauthError === undefined) return;
		setSignInError(oauthError);
		void navigate({
			search: (previous) => ({ ...previous, oauth_error: undefined }),
			replace: true,
		});
	}, [oauthError, navigate]);
	const page = botSettingsPage(pageSegment);
	if (!page) {
		return <Navigate {...botSettingsLink({ handle: bot })} replace />;
	}
	return (
		<SettingsBot handle={bot}>
			{(bot) =>
				// A Personal Assistant's computer is ours to set up; its person changes its look and connections.
				bot.assistant && page === "computer" ? (
					<Navigate {...botSettingsLink(bot)} replace />
				) : (
					<WorkspaceSettings
						section="bots"
						selectedBot={bot}
						botPage={page}
						connectionSignInError={signInError && signInFailureReason(signInError)}
					/>
				)
			}
		</SettingsBot>
	);
}

function SettingsBotConnectionRoute() {
	const { bot, connection } = settingsBotConnectionRoute.useParams();
	return (
		<SettingsBot handle={bot}>
			{(bot) => (
				<WorkspaceSettings
					section="bots"
					selectedBot={bot}
					botPage="connections"
					selectedConnectionId={connection}
				/>
			)}
		</SettingsBot>
	);
}

function SettingsSectionRoute() {
	const { section } = settingsSectionRoute.useParams();
	const setting = workspaceSettingSection(section);
	// `general` is reachable by name too, which is how a phone's list opens it.
	if (!setting) {
		return <Navigate from="/$workspace" to="./settings" replace />;
	}
	return (
		<SettingsLayout>
			<WorkspaceSettings section={setting.id} />
		</SettingsLayout>
	);
}
