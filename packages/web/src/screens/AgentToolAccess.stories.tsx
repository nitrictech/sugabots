import type { Connection, ToolApprovalRule } from "@sugabots/contracts";
import preview from "#storybook/preview";
import { AgentToolsDialog, agentToolsOf } from "./AgentToolAccess.tsx";

const AGENT_ID = "0199a3a0-0000-7000-8000-0000000000a1";

function linear(allowMutating: boolean): Connection {
	return {
		id: "0199a3a0-0000-7000-8000-0000000000f1",
		workspaceId: "0199a3a0-0000-7000-8000-0000000000w1",
		podId: "0199a3a0-0000-7000-8000-0000000000p1",
		name: "Linear",
		handle: "linear",
		url: "https://mcp.linear.app/mcp",
		auth: "oauth",
		signedIn: true,
		secretHeader: null,
		hasSecret: false,
		enabled: true,
		allowMutating,
		status: "connected",
		tools: [
			{
				name: "list_issues",
				description: "List issues in the workspace.",
				readOnly: true,
				destructive: false,
			},
			{
				name: "get_issue",
				description: "Get one issue by its identifier.",
				readOnly: true,
				destructive: false,
			},
			{
				name: "create_issue_label",
				description:
					"Create a new Linear issue label. Deprecated: use `save_issue_label`, which can also update labels.",
				readOnly: false,
				destructive: false,
			},
			{
				name: "save_issue",
				description: "Create or update an issue.",
				readOnly: false,
				destructive: true,
			},
			{
				name: "save_comment",
				description: "Create or update a comment.",
				readOnly: false,
				destructive: true,
			},
		],
		lastTestedAt: "2026-09-19T00:00:00.000Z",
		lastTestError: null,
		createdAt: "2026-09-19T00:00:00.000Z",
	};
}

const alwaysSaveIssue: ToolApprovalRule = {
	id: "0199a3a0-0000-7000-8000-0000000000r1",
	agentId: AGENT_ID,
	agentName: "Personal Assistant",
	connectionId: "0199a3a0-0000-7000-8000-0000000000f1",
	connectionName: "Linear",
	toolName: "save_issue",
	createdAt: "2026-09-19T00:00:00.000Z",
};

const meta = preview.meta({
	title: "Product/AgentToolsDialog",
	component: AgentToolsDialog,
	tags: ["ai-generated"],
	args: {
		agentName: "Personal Assistant",
		connection: linear(false),
		tools: agentToolsOf(linear(false), [], AGENT_ID),
		presetId: "linear",
		markHue: 210,
		open: true,
		onOpenChange: () => {},
	},
});

/** A read-only connection: its reads run freely, and every change is out of the agent's reach. */
export const ReadOnlyConnection = meta.story({});

/** Changes allowed: each asks first, unless someone has always allowed it for this agent. */
export const ChangesAllowed = meta.story({
	args: {
		connection: linear(true),
		tools: agentToolsOf(linear(true), [alwaysSaveIssue], AGENT_ID),
	},
});
