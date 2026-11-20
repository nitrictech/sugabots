import { createRoute, Navigate } from "@tanstack/react-router";
import {
	botComputerLink,
	botConnectionLink,
	botConnectionsLink,
	botSettingsLink,
	botsLink,
	projectBotsLink,
	projectComputerLink,
	projectConnectionLink,
	projectConnectionsLink,
	projectPeopleLink,
	projectSettingsLink,
	projectsLink,
} from "@/lib/links.ts";
import { workspaceSettingSection } from "@/lib/workspace-settings.ts";
import { SettingsLayout } from "@/screens/SettingsLayout.tsx";
import { lazyNamed } from "./lazy-screen.tsx";
import { shellRoute } from "./workspace.tsx";

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

/*
 * Addresses a bot's and a project's settings pages had before they were the
 * owner's own, kept for links already sent out, such as in emails and bots'
 * replies: each goes on to the page it names now.
 */

export const settingsProjectsRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/projects",
	component: () => <Navigate {...projectsLink()} replace />,
});

export const settingsProjectRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/projects/$project",
	component: () => {
		const { project } = settingsProjectRoute.useParams();
		return <Navigate {...projectSettingsLink({ slug: project })} replace />;
	},
});

/** A project's People, Bots, Computer or Connections, as they were named after its settings. */
export const settingsProjectPageRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/projects/$project/$page",
	component: () => {
		const { project, page } = settingsProjectPageRoute.useParams();
		return <Navigate {...movedProjectPageLink({ slug: project }, page)} replace />;
	},
});

export const settingsProjectConnectionRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/projects/$project/connections/$connection",
	component: () => {
		const { project, connection } = settingsProjectConnectionRoute.useParams();
		return <Navigate {...projectConnectionLink({ slug: project }, { id: connection })} replace />;
	},
});

export const settingsBotsRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/bots",
	component: () => <Navigate {...botsLink()} replace />,
});

export const settingsBotRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/bots/$bot",
	component: () => {
		const { bot } = settingsBotRoute.useParams();
		return <Navigate {...botSettingsLink({ handle: bot })} replace />;
	},
});

/** A bot's Computer or Connections, as they were named after its settings. */
export const settingsBotPageRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/bots/$bot/$page",
	component: () => {
		const { bot, page } = settingsBotPageRoute.useParams();
		return <Navigate {...movedBotPageLink({ handle: bot }, page)} replace />;
	},
});

export const settingsBotConnectionRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/bots/$bot/connections/$connection",
	component: () => {
		const { bot, connection } = settingsBotConnectionRoute.useParams();
		return <Navigate {...botConnectionLink({ handle: bot }, { id: connection })} replace />;
	},
});

/** Where a project's page, named after its old settings address, is now; its settings for any other name. */
function movedProjectPageLink(project: { slug: string }, page: string) {
	switch (page) {
		case "people":
			return projectPeopleLink(project);
		case "bots":
			return projectBotsLink(project);
		case "computer":
			return projectComputerLink(project);
		case "connections":
			return projectConnectionsLink(project);
		default:
			return projectSettingsLink(project);
	}
}

/** Where a bot's page, named after its old settings address, is now; its settings for any other name. */
function movedBotPageLink(bot: { handle: string }, page: string) {
	switch (page) {
		case "computer":
			return botComputerLink(bot);
		case "connections":
			return botConnectionsLink(bot);
		default:
			return botSettingsLink(bot);
	}
}

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
