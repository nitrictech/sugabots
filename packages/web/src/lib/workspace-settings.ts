import type { WorkspacePermissions } from "@sugabots/contracts";

/**
 * The settings sections, grouped as the navigation lists them.
 *
 * `needs` names a workspace permission the API resolves, so a section
 * disappears for the same reason its routes refuse: the person does not hold
 * that permission. A group whose sections are all
 * hidden is hidden with them.
 */
export const workspaceSettingGroups = [
	{
		label: "Workspace",
		sections: [
			{ id: "general", label: "General", path: "/settings" },
			{ id: "members", label: "Members", path: "/settings/members" },
			{ id: "usage", label: "Usage", path: "/settings/usage", needs: "manageUsage" },
		],
	},
	{
		label: "Team",
		sections: [
			{ id: "pods", label: "Pods", path: "/settings/pods" },
			{ id: "agents", label: "Bots", path: "/settings/agents" },
			{ id: "routines", label: "Routines", path: "/settings/routines" },
		],
	},
	{
		label: "Intelligence",
		sections: [
			{ id: "providers", label: "Models", path: "/settings/providers", needs: "manageProviders" },
			{ id: "search", label: "Web search", path: "/settings/search", needs: "manageProviders" },
		],
	},
	{
		label: "You",
		sections: [
			{ id: "profile", label: "Profile", path: "/settings/profile" },
			{ id: "notifications", label: "Notifications", path: "/settings/notifications" },
		],
	},
] as const satisfies ReadonlyArray<{
	label: string;
	sections: ReadonlyArray<{
		id: string;
		label: string;
		path: string;
		needs?: keyof WorkspacePermissions;
	}>;
}>;

/** One section of settings, as the navigation lists it. */
export type SettingSection = (typeof workspaceSettingGroups)[number]["sections"][number];

const workspaceSettingSections: readonly SettingSection[] = workspaceSettingGroups.flatMap(
	(group): readonly SettingSection[] => group.sections,
);

export type WorkspaceSettingSection = SettingSection["id"];

export function workspaceSettingSection(section: string): SettingSection | undefined {
	return workspaceSettingSections.find((candidate) => candidate.id === section);
}
