import {
	WORKSPACE_ROLES,
	type WorkspaceRole,
	workspaceRoleDescription,
	workspaceRoleLabel,
} from "@sugabots/contracts";

export interface RoleAbility {
	label: string;
	roles: readonly WorkspaceRole[];
	/** When the answer depends on something, like which pods you're in. */
	note?: string;
}

/** What each role may do, as packages/core/src/authorization/permissions.ts grants it. */
export const roleAbilities: readonly RoleAbility[] = [
	{
		label: "Chat with bots",
		roles: ["owner", "admin", "member", "viewer"],
		note: "In pods they're in; the owner and admins reach every shared pod",
	},
	{ label: "Create and edit bots", roles: ["owner", "admin", "member"] },
	{ label: "Answer a bot's approval in a chat", roles: ["owner", "admin", "member"] },
	{ label: "Delete bots", roles: ["owner", "admin"] },
	{ label: "Create pods", roles: ["owner", "admin"] },
	{ label: "Add and manage connections", roles: ["owner", "admin"] },
	{ label: "Create and manage routines", roles: ["owner", "admin"] },
	{ label: "Answer approvals from routine runs", roles: ["owner", "admin"] },
	{ label: "Connect models and web search", roles: ["owner", "admin"] },
	{ label: "Invite and manage members and viewers", roles: ["owner", "admin"] },
	{ label: "Make, unmake and remove admins", roles: ["owner"] },
	{ label: "Transfer ownership", roles: ["owner"] },
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
