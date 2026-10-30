import type { Pod, WorkspacePermissions } from "@sugabots/contracts";

/**
 * The workspace's own settings sections, as the navigation lists them under
 * Workspace. Pods are listed beneath them, each with its own pages, and your
 * own settings above them all.
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
 * The pods, which the navigation lists one by one rather than as a section.
 * Its own address opens the first, which is where deleting or leaving a pod lands.
 */
const podsSection = {
	id: "pods",
	label: "Pods",
	path: "/settings/pods",
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
	| typeof podsSection;

const allSettingSections: readonly SettingSection[] = [
	...workspaceSettingSections,
	...yourSettingSections,
	podsSection,
];

export type WorkspaceSettingSection = SettingSection["id"];

export function workspaceSettingSection(section: string): SettingSection | undefined {
	return allSettingSections.find((candidate) => candidate.id === section);
}

/** The pages of a pod's settings, as the navigation lists them under it. */
export const podSettingsPages = [
	{ id: "general", label: "General" },
	{ id: "connections", label: "Connections" },
	{ id: "people", label: "People" },
	{ id: "bots", label: "Bots" },
	{ id: "computer", label: "Computer" },
] as const;

export type PodSettingsPage = (typeof podSettingsPages)[number]["id"];

/** The page of a pod's settings an address names after the pod, if it names one. */
export function podSettingsPage(segment: string): PodSettingsPage | undefined {
	return podSettingsPages.find((page) => page.id === segment)?.id;
}

/**
 * The pages `pod` has. A personal pod is only ever yours, can't be renamed,
 * recoloured or deleted, so it has no People and no General: its pages start
 * at Connections. Computer is there only while the workspace has computers.
 */
export function podSettingsPagesOf(pod: Pick<Pod, "kind">, computers: boolean) {
	return podSettingsPages.filter(
		(page) =>
			!(pod.kind === "personal" && (page.id === "general" || page.id === "people")) &&
			(computers || page.id !== "computer"),
	);
}

/**
 * Whether `pod` has `page`, or opening it should go to the pod's Connections
 * instead. Computer is taken to be there, since the workspace's computers are
 * asked for separately and its page says when they are off.
 */
export function podHasSettingsPage(pod: Pick<Pod, "kind">, page: PodSettingsPage): boolean {
	return podSettingsPagesOf(pod, true).some((one) => one.id === page);
}
