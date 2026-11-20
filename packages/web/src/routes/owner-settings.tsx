import { createRoute, Navigate } from "@tanstack/react-router";
import { botSettingsLink } from "@/lib/links.ts";
import type { ProjectSettingsSection } from "@/screens/ProjectSettings.tsx";
import { botRoute } from "./bots.tsx";
import { lazyNamed } from "./lazy-screen.tsx";
import { useBotRouteOwner, useProjectRouteOwner } from "./owner.ts";
import { projectRoute } from "./projects.tsx";

const BotSettingsPage = lazyNamed(() => import("@/screens/BotSettingsPage.tsx"), "BotSettingsPage");
const ProjectSettingsPage = lazyNamed(
	() => import("@/screens/ProjectSettings.tsx"),
	"ProjectSettingsPage",
);
const ComputerSettingsPage = lazyNamed(
	() => import("@/screens/ResourceSettings.tsx"),
	"ComputerSettingsPage",
);

/*
 * A bot's settings and a project's, and the computer each has: pages of its
 * own beside its threads, as its files and connections are.
 */

export const botSettingsRoute = createRoute({
	getParentRoute: () => botRoute,
	path: "/settings",
	loader: () => BotSettingsPage.preload(),
	component: () => {
		const owner = useBotRouteOwner();
		return owner && "bot" in owner ? <BotSettingsPage key={owner.bot.id} bot={owner.bot} /> : null;
	},
});

export const botComputerRoute = createRoute({
	getParentRoute: () => botRoute,
	path: "/computer",
	loader: () => ComputerSettingsPage.preload(),
	component: () => {
		const owner = useBotRouteOwner();
		if (!owner || !("bot" in owner)) return null;
		// A Personal Assistant's computer is ours to set up; its person changes its look and connections.
		if (owner.bot.assistant) return <Navigate {...botSettingsLink(owner.bot)} replace />;
		return <ComputerSettingsPage key={owner.bot.id} owner={owner} />;
	},
});

export const projectSettingsRoute = createRoute({
	getParentRoute: () => projectRoute,
	path: "/settings",
	loader: () => ProjectSettingsPage.preload(),
	component: () => <ProjectSettings section="general" />,
});

export const projectPeopleRoute = createRoute({
	getParentRoute: () => projectRoute,
	path: "/settings/people",
	loader: () => ProjectSettingsPage.preload(),
	component: () => <ProjectSettings section="people" />,
});

export const projectBotsRoute = createRoute({
	getParentRoute: () => projectRoute,
	path: "/settings/bots",
	loader: () => ProjectSettingsPage.preload(),
	component: () => <ProjectSettings section="bots" />,
});

export const projectComputerRoute = createRoute({
	getParentRoute: () => projectRoute,
	path: "/computer",
	loader: () => ComputerSettingsPage.preload(),
	component: () => {
		const owner = useProjectRouteOwner();
		if (!owner || !("project" in owner)) return null;
		return <ComputerSettingsPage key={owner.project.id} owner={owner} />;
	},
});

/** The project the address names, on `section` of its settings. */
function ProjectSettings({ section }: { section: ProjectSettingsSection }) {
	const owner = useProjectRouteOwner();
	if (!owner || !("project" in owner)) return null;
	return <ProjectSettingsPage key={owner.project.id} project={owner.project} section={section} />;
}
