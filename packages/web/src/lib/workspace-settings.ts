import type { WorkspacePermissions } from "@sugabots/contracts";

/**
 * The workspace's own settings sections, as the navigation lists them under
 * Workspace. Projects and bots are listed beneath them, each with its own
 * pages, and your own settings above them all.
 *
 * `needs` names a workspace permission the API resolves, so a section
 * disappears for the same reason its routes refuse: the person does not hold
 * that permission.
 */
export const workspaceSettingSections = [
	{ id: "general", label: "General", path: "/settings" },
	{ id: "members", label: "People", path: "/settings/members" },
	{ id: "providers", label: "Models", path: "/settings/providers", needs: "manageProviders" },
	{ id: "computers", label: "Computers", path: "/settings/computers", needs: "manageProviders" },
	{ id: "search", label: "Web search", path: "/settings/search", needs: "manageProviders" },
	{ id: "usage", label: "Usage", path: "/settings/usage", needs: "manageUsage" },
] as const satisfies ReadonlyArray<SectionShape>;

/** Your own settings, under You at the head of the navigation. */
export const yourSettingSections = [
	{ id: "profile", label: "General", path: "/settings/profile" },
	{ id: "notifications", label: "Notifications", path: "/settings/notifications" },
] as const satisfies ReadonlyArray<SectionShape>;

/**
 * The projects, which the navigation lists one by one rather than as a
 * section. Its own address opens the first, which is where deleting or
 * leaving a project lands.
 */
const projectsSection = {
	id: "projects",
	label: "Projects",
	path: "/settings/projects",
} as const satisfies SectionShape;

/** The bots, listed one by one like the projects. Its own address opens the first. */
const botsSection = {
	id: "bots",
	label: "Bots",
	path: "/settings/bots",
} as const satisfies SectionShape;

interface SectionShape {
	id: string;
	label: string;
	path: string;
	needs?: keyof WorkspacePermissions;
}

/** One section of settings, by its address. */
export type SettingSection =
	| (typeof workspaceSettingSections)[number]
	| (typeof yourSettingSections)[number]
	| typeof projectsSection
	| typeof botsSection;

const allSettingSections: readonly SettingSection[] = [
	...workspaceSettingSections,
	...yourSettingSections,
	projectsSection,
	botsSection,
];

export type WorkspaceSettingSection = SettingSection["id"];

export function workspaceSettingSection(section: string): SettingSection | undefined {
	return allSettingSections.find((candidate) => candidate.id === section);
}

/**
 * The pages of a project's settings, as the navigation lists them under it:
 * its own, its people and bots, and, as a bot's have, the services it is
 * connected to and its computer.
 */
export const projectSettingsPages = [
	{ id: "general", label: "General" },
	{ id: "people", label: "People" },
	{ id: "bots", label: "Bots" },
	{ id: "connections", label: "Connections" },
	{ id: "computer", label: "Computer" },
] as const;

export type ProjectSettingsPage = (typeof projectSettingsPages)[number]["id"];

/** The page of a project's settings an address names after the project, if it names one. */
export function projectSettingsPage(segment: string): ProjectSettingsPage | undefined {
	return projectSettingsPages.find((page) => page.id === segment)?.id;
}

/**
 * The pages of a bot's settings besides its own: the services it is connected
 * to, and its computer, which is there only while the workspace has computers.
 */
export const botSettingsPages = [
	{ id: "general", label: "General" },
	{ id: "connections", label: "Connections" },
	{ id: "computer", label: "Computer" },
] as const;

export type BotSettingsPage = (typeof botSettingsPages)[number]["id"];

/** The page of a bot's settings an address names after the bot, if it names one. */
export function botSettingsPage(segment: string): BotSettingsPage | undefined {
	return botSettingsPages.find((page) => page.id === segment)?.id;
}
