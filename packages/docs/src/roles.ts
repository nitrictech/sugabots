import {
	WORKSPACE_ROLES,
	type WorkspaceRole,
	workspaceRoleDescription,
	workspaceRoleLabel,
} from "@sugabots/contracts";

export interface RoleAbility {
	label: string;
	roles: readonly WorkspaceRole[];
	/** When the answer depends on something, like which bots you made or which projects you're in. */
	note?: string;
}

const EVERYONE: readonly WorkspaceRole[] = ["owner", "admin", "member", "viewer"];
const ALL_BUT_VIEWERS: readonly WorkspaceRole[] = ["owner", "admin", "member"];
const ADMINISTRATORS: readonly WorkspaceRole[] = ["owner", "admin"];

/** Members change only the bots they made; administrators change every bot. */
const BOTS_THEY_MADE = "Members, for bots they made; the owner and admins, for every bot";

/** What each role may do, as packages/core/src/authorization/permissions.ts grants it. */
export const roleAbilities: readonly RoleAbility[] = [
	{
		label: "Talk to bots and take part in their threads",
		roles: EVERYONE,
		note: "Public bots, and their own private ones",
	},
	{
		label: "Join public projects and take part",
		roles: EVERYONE,
		note: "The owner and admins are in every project",
	},
	{
		label: "Change their Personal Assistant's name, look and connections",
		roles: EVERYONE,
	},
	{ label: "Create bots", roles: ALL_BUT_VIEWERS },
	{
		label: "Change and delete bots, with their connections, computer and automations",
		roles: ALL_BUT_VIEWERS,
		note: BOTS_THEY_MADE,
	},
	{
		label: "Answer approvals from automation runs",
		roles: ALL_BUT_VIEWERS,
		note: "Members, for bots they made; the owner and admins, for every bot and project",
	},
	{
		label: "Run automations now",
		roles: ALL_BUT_VIEWERS,
		note: "Projects they're in, and bots they can talk to",
	},
	{
		label: "Answer a bot's approval in a conversation",
		roles: ALL_BUT_VIEWERS,
		note: "Threads of bots they can talk to, and projects they're in",
	},
	{
		label: "Use a project's desktop",
		roles: ALL_BUT_VIEWERS,
		note: "Projects they're in, and bots they can talk to; viewers can watch",
	},
	{ label: "Create projects", roles: ALL_BUT_VIEWERS },
	{
		label: "Invite and remove people, and add and remove bots, in a project",
		roles: ALL_BUT_VIEWERS,
		note: "Projects they're in",
	},
	{
		label: "Leave a project",
		roles: ["member", "viewer"],
		note: "The owner and admins stay in every project",
	},
	{
		label:
			"Rename and delete projects, manage their connections, computers and automations, and delete their files",
		roles: ADMINISTRATORS,
	},
	{ label: "See that private bots exist, but not their threads", roles: ADMINISTRATORS },
	{ label: "Connect models and web search", roles: ADMINISTRATORS },
	{ label: "See what the workspace's models cost", roles: ADMINISTRATORS },
	{ label: "Rename the workspace and set its time zone", roles: ADMINISTRATORS },
	{ label: "Invite and manage members and viewers", roles: ADMINISTRATORS },
	{ label: "Make, unmake and remove admins", roles: ["owner"] },
	{ label: "Transfer ownership", roles: ["owner"] },
	{ label: "Delete the workspace", roles: ["owner"] },
];

/** The roles and what each may do, as Markdown, for readers who can't use the docs' interactive table. */
export function rolesMarkdown(): string {
	const summaries = WORKSPACE_ROLES.map(
		(role) => `- **${workspaceRoleLabel(role)}**: ${workspaceRoleDescription(role)}`,
	);
	const header = `| | ${WORKSPACE_ROLES.map(workspaceRoleLabel).join(" | ")} |`;
	const divider = `| --- |${WORKSPACE_ROLES.map(() => " --- |").join("")}`;
	const rows = roleAbilities.map((ability) => {
		const label = ability.note ? `${ability.label} (${ability.note})` : ability.label;
		const answers = WORKSPACE_ROLES.map((role) => (ability.roles.includes(role) ? "Yes" : "No"));
		return `| ${label} | ${answers.join(" | ")} |`;
	});
	return [summaries.join("\n"), [header, divider, ...rows].join("\n")].join("\n\n");
}
