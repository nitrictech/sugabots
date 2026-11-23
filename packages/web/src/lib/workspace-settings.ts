import type { WorkspacePermissions } from "@sugabots/contracts";

/**
 * The workspace's own settings sections, as the navigation lists them under
 * Workspace, with your own settings above them. A bot's settings, and a
 * project's, are among its own pages, beside its chats.
 *
 * `needs` names a workspace permission the API resolves, so a section
 * disappears for the same reason its routes refuse: the person does not hold
 * that permission.
 */
export const workspaceSettingSections = [
	{ id: "general", label: "General", path: "/settings" },
	{ id: "people", label: "People", path: "/settings/people" },
	{ id: "providers", label: "Models", path: "/settings/providers", needs: "manageProviders" },
	{ id: "computers", label: "Computers", path: "/settings/computers", needs: "manageProviders" },
	{ id: "search", label: "Web search", path: "/settings/search", needs: "manageProviders" },
	{ id: "usage", label: "Usage", path: "/settings/usage", needs: "manageUsage" },
] as const satisfies ReadonlyArray<SectionShape>;

/** Your own settings, under You at the head of the navigation. */
export const yourSettingSections = [
	{ id: "account", label: "General", path: "/settings/account" },
	{ id: "notifications", label: "Notifications", path: "/settings/notifications" },
] as const satisfies ReadonlyArray<SectionShape>;

interface SectionShape {
	id: string;
	label: string;
	path: string;
	needs?: keyof WorkspacePermissions;
}

/** One section of settings, by its address. */
export type SettingSection =
	| (typeof workspaceSettingSections)[number]
	| (typeof yourSettingSections)[number];

const allSettingSections: readonly SettingSection[] = [
	...workspaceSettingSections,
	...yourSettingSections,
];

export type WorkspaceSettingSection = SettingSection["id"];

export function workspaceSettingSection(section: string): SettingSection | undefined {
	return allSettingSections.find((candidate) => candidate.id === section);
}
