import type { WorkspacePermissions } from "@sugabots/contracts";

/**
 * The workspace's own settings sections, as the navigation lists them under
 * Workspace, with your own settings above them. A bot's settings, and a
 * project's, are among its own pages, beside its chats.
 *
 * `needs` names a workspace permission the API resolves, so a section
 * disappears for the same reason its routes refuse: the member does not hold
 * that permission.
 */
export const workspaceSettingSections = [
	{ id: "general", label: "General" },
	{ id: "members", label: "Members" },
	{ id: "providers", label: "Models", needs: "manageProviders" },
	{ id: "computers", label: "Computers", needs: "manageProviders" },
	{ id: "search", label: "Web search", needs: "manageProviders" },
	{ id: "usage", label: "Usage", needs: "manageUsage" },
] as const satisfies ReadonlyArray<SectionShape>;

/** Your own settings, under You at the head of the navigation. */
export const yourSettingSections = [
	{ id: "account", label: "General" },
	{ id: "notifications", label: "Notifications" },
] as const satisfies ReadonlyArray<SectionShape>;

interface SectionShape {
	id: string;
	label: string;
	needs?: keyof WorkspacePermissions;
}

/** One section of settings, as `?settings=` names it by its id. */
export type SettingSection =
	| (typeof workspaceSettingSections)[number]
	| (typeof yourSettingSections)[number];

const allSettingSections: readonly SettingSection[] = [
	...workspaceSettingSections,
	...yourSettingSections,
];

export function workspaceSettingSection(section: string): SettingSection | undefined {
	return allSettingSections.find((candidate) => candidate.id === section);
}
