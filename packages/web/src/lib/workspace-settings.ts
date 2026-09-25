import type { WorkspacePermissions } from "@sugabots/contracts";

/**
 * The settings sections, in the order the navigation lists them.
 *
 * `needs` names a workspace permission the API resolves, so a section
 * disappears for the same reason its routes refuse: the person does not hold
 * that permission. See `docs/permissions.md`.
 *
 * Those sections sit last, because the navigation draws them below a rule: for
 * anybody who does not hold the permission the list simply ends, rather than
 * appearing to have holes in it.
 */
export const workspaceSettingSections = [
	{ id: "general", label: "General", path: "/settings" },
	{ id: "members", label: "Members", path: "/settings/members" },
	{ id: "pods", label: "Pods", path: "/settings/pods" },
	{ id: "agents", label: "Agents", path: "/settings/agents" },
	{
		id: "providers",
		label: "Model providers",
		path: "/settings/providers",
		needs: "manageProviders",
	},
	{
		id: "search",
		label: "Web search",
		path: "/settings/search",
		needs: "manageProviders",
	},
	{
		id: "sandboxes",
		label: "Sandboxes",
		path: "/settings/sandboxes",
		needs: "manageProviders",
	},
	{
		id: "built-in-agents",
		label: "Built-in agents",
		path: "/settings/built-in-agents",
		needs: "configureBuiltInAgents",
	},
] as const satisfies ReadonlyArray<{
	id: string;
	label: string;
	path: string;
	needs?: keyof WorkspacePermissions;
}>;

export type WorkspaceSettingSection = (typeof workspaceSettingSections)[number]["id"];

const podSettingsTabs = ["members", "connections", "routing"] as const;
export type PodSettingsTab = (typeof podSettingsTabs)[number];

export function isPodSettingsTab(value: unknown): value is PodSettingsTab {
	return podSettingsTabs.some((tab) => tab === value);
}

export function workspaceSettingSection(
	section: string,
): (typeof workspaceSettingSections)[number] | undefined {
	return workspaceSettingSections.find((candidate) => candidate.id === section);
}
