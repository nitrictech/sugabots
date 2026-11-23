import type {
	Bot,
	BotColor,
	BotFace,
	BotPermissions,
	BotShape,
	Project,
	ProjectPermissions,
} from "@sugabots/contracts";

/*
 * Projects and bots for the shell's stories, shaped like the design's example
 * workspace: Revenue, Engineering and Design, and the viewer's Personal
 * Assistant.
 */

const WORKSPACE = "0199a3a0-0000-7000-8000-000000000001";
const PERMISSIONS: ProjectPermissions = {
	rename: true,
	manageMembers: true,
	manageBots: true,
	leave: false,
	join: false,
	delete: true,
	resources: {
		readHistory: true,
		openSettings: true,
		deleteFiles: true,
		manageConnections: true,
		manageComputer: true,
		useDesktop: true,
		manageAutomations: true,
		runAutomations: true,
	},
};

/** What the viewer may do with a bot in the stories: everything. */
export const BOT_PERMISSIONS: BotPermissions = {
	update: true,
	delete: true,
	talk: true,
	resources: PERMISSIONS.resources,
};

/**
 * A project the viewer is in, so the workspace's list counts its people and
 * bots: the viewer alone, as the stories' members list answers, and
 * `botCount`, as many as `projectsWithBots` adds to it.
 */
function project(
	id: string,
	name: string,
	color: Project["color"],
	lead: Bot,
	botCount: number,
): Project {
	return {
		id: `0199a3a0-0000-7000-8000-0000000000${id}`,
		workspaceId: WORKSPACE,
		name,
		slug: name.toLowerCase(),
		color,
		description: null,
		leadBotId: lead.id,
		visibility: "public",
		isMember: true,
		permissions: PERMISSIONS,
		memberCount: 1,
		botCount,
		createdAt: "2026-09-01T00:00:00.000Z",
	};
}

let next = 0;
function bot(
	name: string,
	color: BotColor,
	face: BotFace = "pill",
	shape: BotShape = "circle",
	extra: Partial<Bot> = {},
): Bot {
	next += 1;
	return {
		id: `0199a3a0-0000-7000-8000-0000000001${String(next).padStart(2, "0")}`,
		workspaceId: WORKSPACE,
		name,
		handle: name.toLowerCase().replace(/\s+/g, "-"),
		description: null,
		color,
		face,
		shape,
		model: "claude-sonnet-4-20250514",
		prompt: "",
		disabledTools: [],
		usesComputer: false,
		naturalBrowsing: false,
		createdBy: null,
		visibility: "public",
		assistant: false,
		pinned: true,
		defaultProjectId: `0199a3a0-0000-7000-8000-0000000002${String(next).padStart(2, "0")}`,
		permissions: BOT_PERMISSIONS,
		createdAt: "2026-09-01T00:00:00.000Z",
		...extra,
	};
}

export const growthDesk = bot("Growth Desk", "green");
export const accountManager = bot("Account Manager", "sky");
export const leadResearcher = bot("Lead Researcher", "ice");
export const linearHandler = bot("Linear Handler", "orange", "arc", "squircle");
export const oncall = bot("On-call", "rose", "dot", "hexagon");
/** The viewer's Personal Assistant. */
export const chief = bot("Chief", "purple", "wink", "blob", {
	assistant: true,
	visibility: "private",
});

export const revenue = project("a1", "Revenue", "green", growthDesk, 3);
export const engineering = project("a2", "Engineering", "blue", linearHandler, 2);
export const design = project("a3", "Design", "plum", leadResearcher, 1);

/** The projects, each with the bots added to it. */
export const projectsWithBots = [
	{ project: revenue, bots: [growthDesk, accountManager, leadResearcher] },
	{ project: engineering, bots: [linearHandler, oncall] },
	{ project: design, bots: [leadResearcher] },
];

/** Every bot in the stories' workspace. */
export const storyBots: readonly Bot[] = [
	chief,
	growthDesk,
	accountManager,
	leadResearcher,
	linearHandler,
	oncall,
];
