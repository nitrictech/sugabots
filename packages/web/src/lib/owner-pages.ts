import type { Bot } from "@sugabots/contracts";
import { Folder, type LucideIcon, Monitor, Settings2, Wrench, Zap } from "lucide-react";
import { type OwnerPage, type ResourceOwner, resourcePermissions } from "@/lib/resource-owner.tsx";

/** One of a bot's or a project's own pages, as its sidebar and a phone's page of it list them. */
interface OwnerPageEntry {
	to: Extract<OwnerPage, { page: OwnerPageName }>;
	label: string;
	icon: LucideIcon;
}

/** A bot's and a project's own pages, each named by the segment of its address after the owner's. */
export const OWNER_PAGE_NAMES = [
	"files",
	"automations",
	"computer",
	"connections",
	"settings",
] as const;

export type OwnerPageName = (typeof OWNER_PAGE_NAMES)[number];

/**
 * The owner's own pages the viewer may open, in the order they are listed:
 * its files and automations, then, for whoever may open its settings, its
 * computers while the workspace has them and the owner uses one, its
 * connections and its settings. A project's bots all use its computer.
 */
export function ownerPages(
	owner: ResourceOwner,
	{ computersOn }: { computersOn: boolean },
): OwnerPageEntry[] {
	const usesComputer = computersOn && ("bot" in owner ? owner.bot.usesComputer : true);
	return [
		{ to: { page: "files" }, label: "Files", icon: Folder },
		{ to: { page: "automations" }, label: "Automations", icon: Zap },
		...(resourcePermissions(owner).openSettings
			? [
					...(usesComputer
						? [{ to: { page: "computer" } as const, label: "Computers", icon: Monitor }]
						: []),
					{ to: { page: "connections" } as const, label: "Connections", icon: Wrench },
					{ to: { page: "settings" } as const, label: "Settings", icon: Settings2 },
				]
			: []),
	];
}

/**
 * What is wrong with an owner, by the page of its that sets it right: its
 * settings for no lead bot, no model or one since switched off, and its
 * automations for one whose latest run failed.
 */
type OwnerProblems = Partial<Record<OwnerPageName, string>>;

/** The problem an owner's automations page sets right: one of them is failing. */
const AUTOMATION_FAILED = "An automation's last run failed";

/**
 * What stops the owner working that its own pages set right. `lead` is the
 * bot itself, or a project's lead bot; `enabledModels` the workspace's models
 * switched on, undefined until loaded.
 */
export function ownerProblems(
	owner: ResourceOwner,
	{
		lead,
		enabledModels,
		automationFailed,
	}: {
		lead: Bot | undefined;
		enabledModels: readonly { modelId: string }[] | undefined;
		automationFailed: boolean;
	},
): OwnerProblems {
	return {
		settings: settingsProblem(owner, lead, enabledModels),
		automations: automationFailed ? AUTOMATION_FAILED : undefined,
	};
}

function settingsProblem(
	owner: ResourceOwner,
	lead: Bot | undefined,
	enabledModels: readonly { modelId: string }[] | undefined,
): string | undefined {
	if (!lead) return "No lead bot chosen";
	if (lead.model === null)
		return "bot" in owner ? "No model chosen" : `${lead.name} has no model chosen`;
	if (enabledModels && !enabledModels.some((model) => model.modelId === lead.model)) {
		return "This model is no longer switched on for the workspace";
	}
	return undefined;
}
