import type { TestConnector } from "@sugabots/contracts/testing";
import { growthDesk, revenue } from "@/shell/story-fixtures.test-support.ts";

/** A bot's connector whose sign-in the server refused during a turn. */
export function expiredConnector(n: number, name: string, url: string): TestConnector {
	return {
		id: `0199a3a0-0000-7000-8000-0000000007${String(n).padStart(2, "0")}`,
		workspaceId: revenue.workspaceId,
		projectId: growthDesk.defaultProjectId,
		name,
		handle: name.toLowerCase(),
		url,
		kind: "mcp",
		auth: "oauth",
		signedIn: false,
		signInExpired: true,
		secretHeader: null,
		hasSecret: false,
		appSettingsUrl: null,
		status: "connected",
		tools: [
			{
				name: "search",
				description: "Search",
				readOnly: true,
				destructive: false,
				access: "allow",
			},
		],
		lastTestError: null,
		connectedBy: {
			id: "0199a3a0-0000-7000-8000-0000000000c3",
			name: "Sam Rivera",
			email: "sam.rivera@example.com",
			image: null,
		},
		signedInAs: null,
		createdAt: "2026-09-01T00:00:00.000Z",
	};
}

export const expiredLinear = expiredConnector(1, "Linear", "https://mcp.linear.app/mcp");
