import type { Bot, Project } from "@sugabots/contracts";
import { createRoute, Navigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { useBotWithHandle } from "@/lib/bots.ts";
import { signInFailureReason } from "@/lib/connections.ts";
import { botSettingsLink, projectSettingsLink } from "@/lib/links.ts";
import { findProject, useProjects } from "@/lib/projects.ts";
import {
	botSettingsPage,
	projectSettingsPage,
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

export const settingsProjectRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/projects/$project",
	// The dialog waits for the rosters, so its code downloads alongside rather than after.
	loader: () => WorkspaceSettings.preload(),
	component: SettingsProjectRoute,
});

/** One of a project's pages besides General: People, Bots, Connections or Computer. */
export const settingsProjectPageRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/projects/$project/$page",
	validateSearch: (search: Record<string, unknown>): { oauth_error?: string } => ({
		oauth_error: optionalString(search.oauth_error),
	}),
	// A sign-in error shown for one project must not follow you to the next.
	remountDeps: ({ params }) => [params.workspace, params.project],
	loader: () => WorkspaceSettings.preload(),
	component: SettingsProjectPageRoute,
});

/** One of a project's connections, by its id. */
export const settingsProjectConnectionRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/projects/$project/connections/$connection",
	loader: () => WorkspaceSettings.preload(),
	component: SettingsProjectConnectionRoute,
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

function SettingsProjectRoute() {
	const { project: slug } = settingsProjectRoute.useParams();
	const { data: projects, isPending, error } = useProjects();
	// A project's settings are for the people in it.
	const project = memberProject(projects, slug);
	if (isPending) return <SettingsLayout>{null}</SettingsLayout>;
	if (!project) return <ProjectSettingsMissing projects={projects} slug={slug} error={error} />;
	return (
		<SettingsLayout>
			<WorkspaceSettings section="projects" selectedProjectId={project.id} />
		</SettingsLayout>
	);
}

function SettingsProjectPageRoute() {
	const { project: slug, page: pageSegment } = settingsProjectPageRoute.useParams();
	const signInError = useSignInErrorOnce(settingsProjectPageRoute);
	const { data: projects, isPending, error } = useProjects();
	const project = memberProject(projects, slug);
	const page = projectSettingsPage(pageSegment);
	if (!page) {
		return <Navigate {...projectSettingsLink({ slug })} replace />;
	}
	if (isPending) return <SettingsLayout>{null}</SettingsLayout>;
	if (!project) return <ProjectSettingsMissing projects={projects} slug={slug} error={error} />;
	return (
		<SettingsLayout>
			<WorkspaceSettings
				section="projects"
				selectedProjectId={project.id}
				projectPage={page}
				connectionSignInError={signInError && signInFailureReason(signInError)}
			/>
		</SettingsLayout>
	);
}

function SettingsProjectConnectionRoute() {
	const { project: slug, connection } = settingsProjectConnectionRoute.useParams();
	const { data: projects, isPending, error } = useProjects();
	const project = memberProject(projects, slug);
	if (isPending) return <SettingsLayout>{null}</SettingsLayout>;
	if (!project) return <ProjectSettingsMissing projects={projects} slug={slug} error={error} />;
	return (
		<SettingsLayout>
			<WorkspaceSettings
				section="projects"
				selectedProjectId={project.id}
				projectPage="connections"
				selectedConnectionId={connection}
			/>
		</SettingsLayout>
	);
}

/**
 * Why the sign-in that returned to `route`'s page did not finish, as its
 * `?oauth_error=` said, taken out of the address once read and kept, so a
 * reload does not show it twice.
 */
function useSignInErrorOnce(
	route: typeof settingsProjectPageRoute | typeof settingsBotPageRoute,
): string | undefined {
	const { oauth_error: oauthError } = route.useSearch();
	const navigate = route.useNavigate();
	const [signInError, setSignInError] = useState(oauthError);
	useEffect(() => {
		if (oauthError === undefined) return;
		setSignInError(oauthError);
		void navigate({
			search: (previous) => ({ ...previous, oauth_error: undefined }),
			replace: true,
		});
	}, [oauthError, navigate]);
	return signInError;
}

/**
 * Why a project's settings are not shown: it could not be loaded, it is not
 * here, or the person is not in it, which a public project's own page joins.
 */
function ProjectSettingsMissing({
	projects,
	slug,
	error,
}: {
	projects: readonly Project[] | undefined;
	slug: string;
	error: unknown;
}) {
	const project = findProject(projects, slug);
	return (
		<Panes>
			{project ? (
				<EmptyState title="You're not in this project">
					Join it from its page to see its settings.
				</EmptyState>
			) : (
				<EmptyState title={error ? "Could not load this project" : "No such project here"} />
			)}
		</Panes>
	);
}

/** The project at `slug` when the person is in it, as its settings need. */
function memberProject(
	projects: readonly Project[] | undefined,
	slug: string,
): Project | undefined {
	const project = findProject(projects, slug);
	return project?.isMember ? project : undefined;
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
	const signInError = useSignInErrorOnce(settingsBotPageRoute);
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
