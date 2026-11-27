import type { ConnectorAccess, ConnectorTool } from "@sugabots/contracts";
import type { TestConnector } from "@sugabots/contracts/testing";
import { revenue } from "@/shell/story-fixtures.test-support.ts";

/** A connector whose tools are all at `access`. */
export function storyConnector(
	idSuffix: string,
	{
		access = "allow",
		tools = [
			{ name: "list_issues", description: "List issues", readOnly: true, destructive: false },
			{ name: "create_issue", description: "Open an issue", readOnly: false, destructive: false },
		],
		...fields
	}: Partial<Omit<TestConnector, "tools">> &
		Pick<TestConnector, "name" | "handle" | "url"> & {
			access?: ConnectorAccess;
			tools?: ConnectorTool[];
		},
): TestConnector {
	return {
		id: `0199a3a0-0000-7000-8000-00000000${idSuffix}`,
		workspaceId: revenue.workspaceId,
		projectId: revenue.id,
		kind: "mcp",
		auth: "header",
		signedIn: true,
		signInExpired: false,
		secretHeader: "Authorization",
		hasSecret: true,
		appSettingsUrl: null,
		status: "connected",
		tools: tools.map((tool) => ({ ...tool, access })),
		lastTestError: null,
		connectedBy: {
			id: "0199a3a0-0000-7000-8000-000000000009",
			name: "Rowan Ellis",
			email: "rowan@example.com",
			image: null,
		},
		signedInAs: null,
		createdAt: "2026-09-01T00:00:00.000Z",
		...fields,
	};
}
