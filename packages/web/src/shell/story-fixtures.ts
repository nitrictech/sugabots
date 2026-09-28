import type { Agent, AgentColor, AgentFace, Pod, PodPermissions } from "@sugabots/contracts";
import { DEFAULT_POD_ROUTING } from "@sugabots/contracts";

/*
 * Pods and bots for the shell's stories, shaped like the design's example
 * workspace: Revenue and Engineering, plus Personal.
 */

const WORKSPACE = "0199a3a0-0000-7000-8000-000000000001";
const PERMISSIONS: PodPermissions = {
	rename: true,
	changeRouting: true,
	manageMembers: true,
	leave: false,
	createAgents: true,
	updateAgents: true,
	deleteAgents: true,
	manageConnections: true,
	manageRoutines: true,
	runRoutines: true,
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
		routing: DEFAULT_POD_ROUTING,
		permissions: PERMISSIONS,
		createdAt: "2026-09-01T00:00:00.000Z",
	};
}

export const revenue = pod("a1", "Revenue", "green");
export const engineering = pod("a2", "Engineering", "blue");
export const design = pod("a3", "Design", "plum");
export const personal = pod("af", "Personal", null);

let next = 0;
function bot(name: string, home: Pod, color: AgentColor, face: AgentFace = "pill"): Agent {
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
		model: "claude-sonnet-4-20250514",
		prompt: "",
		disabledTools: [],
		createdAt: "2026-09-01T00:00:00.000Z",
	};
}

export const growthDesk = bot("Growth Desk", revenue, "green");
export const accountManager = bot("Account Manager", revenue, "sky");
export const leadResearcher = bot("Lead Researcher", revenue, "ice");
export const linearHandler = bot("Linear Handler", engineering, "orange", "arc");
export const oncall = bot("On-call", engineering, "rose", "dot");
export const chief = bot("Chief", personal, "purple", "wink");

export const podsWithBots = [
	{ pod: revenue, bots: [growthDesk, accountManager, leadResearcher] },
	{ pod: engineering, bots: [linearHandler, oncall] },
	{ pod: design, bots: [] },
	{ pod: personal, bots: [chief] },
];
