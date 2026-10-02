import type { Connection, ConnectionAccess } from "@sugabots/contracts";
import preview from "#storybook/preview";
import { AgentToolsDialog, agentToolsOf } from "./AgentToolAccess.tsx";

function linear(access: ConnectionAccess): Connection {
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
		access,
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

const meta = preview.meta({
	title: "Product/AgentToolsDialog",
	component: AgentToolsDialog,
	tags: ["ai-generated"],
	args: {
		agentName: "Personal Assistant",
		connection: linear("allow"),
		tools: agentToolsOf(linear("allow")),
		presetId: "linear",
		open: true,
		onOpenChange: () => {},
	},
});

/** Allowed: every tool runs freely, changes included. */
export const Allowed = meta.story({});

/** Set to ask: every call waits for a person, reads included. */
export const Asks = meta.story({
	args: {
		connection: linear("ask"),
		tools: agentToolsOf(linear("ask")),
	},
});
