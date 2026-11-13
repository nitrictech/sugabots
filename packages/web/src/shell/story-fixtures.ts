import type {
	Agent,
	AgentColor,
	AgentFace,
	AgentShape,
	Direct,
	DirectMessageListItem,
	Pod,
	PodPermissions,
} from "@sugabots/contracts";
import { testPerson } from "@sugabots/contracts/testing";

/*
 * Pods and bots for the shell's stories, shaped like the design's example
 * workspace: Revenue and Engineering, plus Personal.
 */

const WORKSPACE = "0199a3a0-0000-7000-8000-000000000001";
const PERMISSIONS: PodPermissions = {
	rename: true,
	manageMembers: true,
	leave: false,
	createAgents: true,
	updateAgents: true,
	deleteAgents: true,
	manageConnections: true,
	manageSandbox: true,
	useDesktops: true,
	manageRoutines: true,
	runRoutines: true,
	deleteArtifacts: true,
};

function pod(id: string, name: string, color: Pod["color"]): Pod {
	const kind = color === null ? "personal" : "shared";
	return {
		id: `0199a3a0-0000-7000-8000-0000000000${id}`,
		workspaceId: WORKSPACE,
		ownerId: null,
		kind,
		name,
		slug: kind === "personal" ? "personal" : name.toLowerCase(),
		color,
		permissions: PERMISSIONS,
		createdAt: "2026-09-01T00:00:00.000Z",
	};
}

export const revenue = pod("a1", "Revenue", "green");
export const engineering = pod("a2", "Engineering", "blue");
export const design = pod("a3", "Design", "plum");
export const personal = pod("af", "Personal", null);

let next = 0;
function bot(
	name: string,
	home: Pod,
	color: AgentColor,
	face: AgentFace = "pill",
	shape: AgentShape = "circle",
): Agent {
	next += 1;
	return {
		id: `0199a3a0-0000-7000-8000-0000000001${String(next).padStart(2, "0")}`,
		workspaceId: WORKSPACE,
		podId: home.id,
		name,
		handle: name.toLowerCase().replace(/\s+/g, "-"),
		systemAgentKey: null,
		description: null,
		color,
		face,
		shape,
		model: "claude-sonnet-4-20250514",
		prompt: "",
		disabledTools: [],
		usesSandbox: false,
		naturalBrowsing: false,
		createdById: null,
		createdAt: "2026-09-01T00:00:00.000Z",
	};
}

export const growthDesk = bot("Growth Desk", revenue, "green");
export const accountManager = bot("Account Manager", revenue, "sky");
export const leadResearcher = bot("Lead Researcher", revenue, "ice");
export const linearHandler = bot("Linear Handler", engineering, "orange", "arc", "squircle");
export const oncall = bot("On-call", engineering, "rose", "dot", "hexagon");
export const chief = bot("Chief", personal, "purple", "wink", "blob");

export const podsWithBots = [
	{ pod: revenue, bots: [growthDesk, accountManager, leadResearcher] },
	{ pod: engineering, bots: [linearHandler, oncall] },
	{ pod: design, bots: [] },
	{ pod: personal, bots: [chief] },
];

/** The viewer's id in the shell's stories. */
const VIEWER_ID = "0199a3a0-0000-7000-8000-000000000009";

/** Other people in the example workspace. */
export const priya = testPerson({
	id: "0199a3a0-0000-7000-8000-0000000005a1",
	name: "Priya Shah",
	email: "priya@nitric.io",
});
export const marco = testPerson({
	id: "0199a3a0-0000-7000-8000-0000000005a2",
	name: "Marco Bell",
	email: "marco@nitric.io",
});
export const theo = testPerson({
	id: "0199a3a0-0000-7000-8000-0000000005a3",
	name: "Theo Hart",
	email: "theo@nitric.io",
});

function direct(id: string): Direct {
	return {
		kind: "direct",
		id: `0199a3a0-0000-7000-8000-0000000006${id}`,
		workspaceId: WORKSPACE,
		title: "Direct message",
		createdAt: "2026-09-18T06:00:00.000Z",
		updatedAt: "2026-09-18T06:10:00.000Z",
	};
}

/** A direct message with Priya, two of whose messages are unread. */
export const withPriya: DirectMessageListItem = {
	conversation: direct("c1"),
	people: [priya],
	formerMembers: 0,
	lastMessage: {
		preview: "Can you look over the renewal deck before Thursday?",
		authorUserId: priya.id,
		at: "2026-09-18T06:10:00.000Z",
	},
	unreadMessages: 2,
};

/** A group of two: Priya and Theo, with one message unread. */
export const withPriyaAndTheo: DirectMessageListItem = {
	conversation: direct("c2"),
	people: [priya, theo],
	formerMembers: 0,
	lastMessage: {
		preview: "Who's bringing the projector?",
		authorUserId: theo.id,
		at: "2026-09-18T05:40:00.000Z",
	},
	unreadMessages: 1,
};

/** A direct message with Marco, all read. */
export const withMarco: DirectMessageListItem = {
	conversation: direct("c3"),
	people: [marco],
	formerMembers: 0,
	lastMessage: {
		preview: "Thanks, merged.",
		authorUserId: VIEWER_ID,
		at: "2026-09-17T23:00:00.000Z",
	},
	unreadMessages: 0,
};

/** A direct message with Theo, nothing written in it yet. */
export const withTheo: DirectMessageListItem = {
	conversation: direct("c4"),
	people: [theo],
	formerMembers: 0,
	lastMessage: null,
	unreadMessages: 0,
};

/** A direct message with somebody who has since left the workspace. */
export const withFormerMember: DirectMessageListItem = {
	conversation: direct("c5"),
	people: [],
	formerMembers: 1,
	lastMessage: {
		preview: "Handing over the Q3 notes here.",
		authorUserId: null,
		at: "2026-09-10T02:00:00.000Z",
	},
	unreadMessages: 0,
};

/** A group: Marco, Priya and Theo, and one more who has since left, with one message unread. */
export const withGroup: DirectMessageListItem = {
	conversation: direct("c6"),
	people: [marco, priya, theo],
	formerMembers: 1,
	lastMessage: {
		preview: "Offsite moved to the 14th.",
		authorUserId: theo.id,
		at: "2026-09-18T05:00:00.000Z",
	},
	unreadMessages: 1,
};

/** The viewer's direct messages, most recent first. */
export const directMessages: DirectMessageListItem[] = [
	withPriya,
	withPriyaAndTheo,
	withGroup,
	withMarco,
	withTheo,
	withFormerMember,
];
