import {
	WORKSPACE_ROLES,
	type WorkspaceRole,
	workspaceRoleDescription,
	workspaceRoleLabel,
} from "@sugabots/contracts";

interface RoleAbility {
	label: string;
	roles: readonly WorkspaceRole[];
	/** When the answer depends on something, like which bots you made or which projects you're in. */
	note?: string;
}

const EVERYONE = WORKSPACE_ROLES;
const ALL_BUT_VIEWERS: readonly WorkspaceRole[] = ["owner", "admin", "editor"];
const ADMINISTRATORS: readonly WorkspaceRole[] = ["owner", "admin"];

/** What each role may do, as the provers in packages/core/src/proofs/ allow it. */
export const roleAbilities: readonly RoleAbility[] = [
	{
		label: "Talk to bots and take part in their chats",
		roles: EVERYONE,
		note: "Public bots, private bots they belong to, and their own personal bots",
	},
	{
		label: "Join public projects and take part",
		roles: EVERYONE,
		note: "The owner and admins are in every project members made",
	},
	{
		label: "Make their own Personal Assistants",
		roles: EVERYONE,
	},
	{
		label: "Manage or delete their own personal bots and start their automation runs",
		roles: EVERYONE,
		note: "Sugabots keeps each Personal Assistant's instructions and handle fixed",
	},
	{
		label: "Create public, private or personal bots",
		roles: ALL_BUT_VIEWERS,
	},
	{
		label: "Change or delete public and private bots",
		roles: ALL_BUT_VIEWERS,
		note: "Editors, for bots they made and can talk to. The owner and admins, for all public and private bots",
	},
	{
		label: "Delete another member's personal bot or switch off its connectors and automations",
		roles: ADMINISTRATORS,
	},
	{
		label: "Answer approvals from automation runs",
		roles: EVERYONE,
		note: "The workspace's owner and admins, and the creator if they can manage the bot doing the run, can answer if they can open the run. The creator answers for their own personal bot. Requests to change a computer follow a separate rule",
	},
	{
		label: "Start automation runs in projects and for public or private bots",
		roles: ALL_BUT_VIEWERS,
		note: "Projects they belong to and public or private bots they can talk to. Paused automations can also be started by hand",
	},
	{
		label: "Answer a bot's approval in a chat",
		roles: EVERYONE,
		note: "For ordinary tool calls, the member whose message the bot is answering",
	},
	{
		label: "Answer a request to add an allowed host",
		roles: EVERYONE,
		note: "Anyone for their own personal bots. Editors, in the own chats of public or private bots they made and can talk to. The owner and admins for public or private bots and projects members made",
	},
	{
		label: "Mark chats resolved and reopen them",
		roles: EVERYONE,
		note: "Viewers can do this in chats with their own personal bots",
	},
	{
		label: "Click and type on a computer's desktop",
		roles: EVERYONE,
		note: "Viewers can click and type on their own personal bots' desktops. They can watch other desktops they can reach",
	},
	{ label: "Create projects", roles: ALL_BUT_VIEWERS },
	{
		label: "Invite and remove members of a private bot",
		roles: ALL_BUT_VIEWERS,
		note: "Private bots they belong to. The owner, admins and any creator already in the bot stay members",
	},
	{
		label: "Turn a bot's own connectors on or off for a project",
		roles: ADMINISTRATORS,
	},
	{
		label: "Invite and remove members, and add and remove bots, in a project",
		roles: ALL_BUT_VIEWERS,
		note: "Projects they're in",
	},
	{
		label: "Leave a project",
		roles: ["editor", "viewer"],
		note: "The owner and admins stay in every project members made",
	},
	{
		label:
			"Change project settings, choose the lead bot, delete projects or their files, and manage project connectors, computers and automations",
		roles: ADMINISTRATORS,
	},
	{ label: "See that personal bots exist, but not their chats", roles: ADMINISTRATORS },
	{ label: "Connect models and web search", roles: ADMINISTRATORS },
	{ label: "See what the workspace's models cost", roles: ADMINISTRATORS },
	{ label: "Rename the workspace and set its time zone", roles: ADMINISTRATORS },
	{ label: "Invite and manage editors and viewers", roles: ADMINISTRATORS },
	{ label: "Make, unmake and remove admins", roles: ["owner"] },
	{ label: "Hand over ownership", roles: ["owner"] },
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
