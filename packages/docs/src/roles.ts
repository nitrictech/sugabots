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

/**
 * Editors change only the bots they made; administrators change every public
 * or private bot, and may only delete another member's personal bot, a
 * Personal Assistant included, or pause its automations.
 */
const BOTS_THEY_MADE =
	"Editors, for bots they made; the owner and admins, for every public or private bot, but another member's personal bot, Personal Assistants included, only to delete it or pause its automations";

/** What each role may do, as the provers in packages/core/src/proofs/ allow it. */
export const roleAbilities: readonly RoleAbility[] = [
	{
		label: "Talk to bots and take part in their chats",
		roles: EVERYONE,
		note: "Public bots, and their own personal ones",
	},
	{
		label: "Join public projects and take part",
		roles: EVERYONE,
		note: "The owner and admins are in every project members made",
	},
	{
		label: "Make, manage and delete their own Personal Assistants, and run their automations",
		roles: EVERYONE,
		note: "All but their instructions, which Sugabots keeps",
	},
	{
		label: "Create bots",
		roles: ALL_BUT_VIEWERS,
		note: "Personal Assistants aside, which everyone may make",
	},
	{
		label: "Change and delete bots, with their connectors, computer and automations",
		roles: ALL_BUT_VIEWERS,
		note: BOTS_THEY_MADE,
	},
	{
		label: "Answer approvals from automation runs",
		roles: EVERYONE,
		note: "In chats they can see, of runs done by bots they manage: editors, bots they made; the owner and admins, every public or private bot. A personal bot's runs, a Personal Assistant's included, ask only its creator, even a viewer",
	},
	{
		label: "Start automation runs",
		roles: ALL_BUT_VIEWERS,
		note: "Projects they're in, and bots they can talk to",
	},
	{
		label: "Answer a bot's approval in a chat",
		roles: EVERYONE,
		note: "Only for calls a bot makes while working for them: a bot asks the member whose message it is answering",
	},
	{
		label: "Answer a bot's request to change a computer, such as a host it may reach",
		roles: EVERYONE,
		note: "Viewers, in their own Personal Assistants' chats; editors, in their own bots' chats; the owner and admins, in projects members made and public or private bots' chats",
	},
	{
		label: "Mark chats resolved and reopen them",
		roles: ALL_BUT_VIEWERS,
		note: "Chats they can see",
	},
	{
		label: "Use a project's desktop",
		roles: ALL_BUT_VIEWERS,
		note: "Projects they're in, and bots they can talk to; viewers can watch",
	},
	{ label: "Create projects", roles: ALL_BUT_VIEWERS },
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
			"Rename and delete projects, manage their connectors, computers and automations, and delete their files",
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
