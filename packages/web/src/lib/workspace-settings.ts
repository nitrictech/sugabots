import type { WorkspacePermissions } from "@sugabots/contracts";

/**
 * The workspace's own settings sections, as the navigation lists them under
 * Workspace. Channels and bots are listed beneath them, each with its own
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
	{ id: "sandboxes", label: "Computers", path: "/settings/sandboxes", needs: "manageProviders" },
	{ id: "search", label: "Web search", path: "/settings/search", needs: "manageProviders" },
	{ id: "usage", label: "Usage", path: "/settings/usage", needs: "manageUsage" },
] as const satisfies ReadonlyArray<SectionShape>;

/** Your own settings, under You at the head of the navigation. */
export const yourSettingSections = [
	{ id: "profile", label: "General", path: "/settings/profile" },
	{ id: "notifications", label: "Notifications", path: "/settings/notifications" },
] as const satisfies ReadonlyArray<SectionShape>;

/**
 * The channels, which the navigation lists one by one rather than as a
 * section. Its own address opens the first, which is where deleting or
 * leaving a channel lands.
 */
const channelsSection = {
	id: "channels",
	label: "Channels",
	path: "/settings/channels",
} as const satisfies SectionShape;

/** The bots, listed one by one like the channels. Its own address opens the first. */
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
	| typeof channelsSection
	| typeof botsSection;

const allSettingSections: readonly SettingSection[] = [
	...workspaceSettingSections,
	...yourSettingSections,
	channelsSection,
	botsSection,
];

export type WorkspaceSettingSection = SettingSection["id"];

export function workspaceSettingSection(section: string): SettingSection | undefined {
	return allSettingSections.find((candidate) => candidate.id === section);
}

/** The pages of a channel's settings, as the navigation lists them under it. */
export const podSettingsPages = [
	{ id: "general", label: "General" },
	{ id: "people", label: "People" },
	{ id: "bots", label: "Bots" },
] as const;

export type PodSettingsPage = (typeof podSettingsPages)[number]["id"];

/** The page of a channel's settings an address names after the channel, if it names one. */
export function podSettingsPage(segment: string): PodSettingsPage | undefined {
	return podSettingsPages.find((page) => page.id === segment)?.id;
}

/**
 * The pages of a bot's settings besides its own: the services it is connected
 * to, and its computer, which is there only while the workspace has computers.
 */
export const agentSettingsPages = [
	{ id: "general", label: "General" },
	{ id: "connections", label: "Connections" },
	{ id: "computer", label: "Computer" },
] as const;

export type AgentSettingsPage = (typeof agentSettingsPages)[number]["id"];

/** The page of a bot's settings an address names after the bot, if it names one. */
export function agentSettingsPage(segment: string): AgentSettingsPage | undefined {
	return agentSettingsPages.find((page) => page.id === segment)?.id;
}
