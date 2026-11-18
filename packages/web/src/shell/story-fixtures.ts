import type {
	Bot,
	BotColor,
	BotFace,
	BotPermissions,
	BotShape,
	Channel,
	ChannelPermissions,
	DirectMessage,
	DirectMessageListItem,
} from "@sugabots/contracts";
import { testPerson } from "@sugabots/contracts/testing";

/*
 * Channels and bots for the shell's stories, shaped like the design's example
 * workspace: Revenue, Engineering and Design, and the viewer's Personal
 * Assistant.
 */

const WORKSPACE = "0199a3a0-0000-7000-8000-000000000001";
const PERMISSIONS: ChannelPermissions = {
	rename: true,
	manageMembers: true,
	manageBots: true,
	leave: false,
	join: false,
	delete: true,
	deleteFiles: true,
};

/** What the viewer may do with a bot in the stories: everything. */
export const BOT_PERMISSIONS: BotPermissions = {
	update: true,
	delete: true,
	manageConnections: true,
	manageComputer: true,
	useDesktop: true,
	manageAutomations: true,
	runAutomations: true,
	talk: true,
};

function channel(id: string, name: string, color: Channel["color"]): Channel {
	return {
		id: `0199a3a0-0000-7000-8000-0000000000${id}`,
		workspaceId: WORKSPACE,
		name,
		slug: name.toLowerCase(),
		color,
		description: null,
		visibility: "public",
		isMember: true,
		permissions: PERMISSIONS,
		createdAt: "2026-09-01T00:00:00.000Z",
	};
}

export const revenue = channel("a1", "Revenue", "green");
export const engineering = channel("a2", "Engineering", "blue");
export const design = channel("a3", "Design", "plum");

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
		systemBotKey: null,
		description: null,
		color,
		face,
		shape,
		model: "claude-sonnet-4-20250514",
		prompt: "",
		disabledTools: [],
		usesComputer: false,
		naturalBrowsing: false,
		createdById: null,
		visibility: "public",
		assistant: false,
		pinned: true,
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

/** The channels, each with the bots added to it. */
export const channelsWithBots = [
	{ channel: revenue, bots: [growthDesk, accountManager, leadResearcher] },
	{ channel: engineering, bots: [linearHandler, oncall] },
	{ channel: design, bots: [] },
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

function direct(id: string): DirectMessage {
	return {
		kind: "direct_message",
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
