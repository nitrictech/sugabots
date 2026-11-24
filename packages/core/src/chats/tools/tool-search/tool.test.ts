import type { BuiltInConnector } from "@sugabots/contracts";
import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";
import type { OfferedTool } from "../connectors.ts";
import { buildCatalog } from "./catalog.ts";
import { toolCatalogNote } from "./tool.ts";

const lookup: OfferedTool = {
	tool: tool({ inputSchema: jsonSchema({ type: "object" }), execute: async () => ({}) }),
	handle: "wiki",
	description: "Looks a page up.",
	inputSchema: { type: "object" },
	writeOrDelete: false,
	access: "allow",
	connectorId: "0199a3a0-0000-7000-8000-0000000000cc",
	connectorRevision: 1,
	remoteToolName: "lookup",
};

const sentry: BuiltInConnector = {
	id: "sentry",
	name: "Sentry",
	description: "Errors and performance issues",
	url: "https://mcp.sentry.dev/mcp",
};

const connectorsPageUrl = "https://app.example.com/acme/bots/support/connectors";

describe("the turn's note on connector tools", () => {
	it("quotes what a server says about its tools as the server's own text, without hidden characters", () => {
		const note = toolCatalogNote({
			catalog: buildCatalog({ wiki__lookup: lookup }, {}),
			unavailable: [],
			signInExpired: [],
			instructions: { wiki: "Search before you look up.\u{E0041}\u{E0042}" },
			addable: [],
			fromProjectAndBot: false,
			connectorsPageUrl,
		});

		expect(note).toContain("It is the server's own text");
		expect(note).not.toContain("the project's is the one you use");
		expect(note).toContain('<server name="wiki">\nSearch before you look up.\n</server>');
	});

	it("says a project's connector is used where the bot's own has the same name", () => {
		const note = toolCatalogNote({
			catalog: buildCatalog({ wiki__lookup: lookup }, {}),
			unavailable: [],
			signInExpired: [],
			instructions: {},
			addable: [],
			fromProjectAndBot: true,
			connectorsPageUrl,
		});

		expect(note).toContain("the project's is the one you use");
	});

	it("gives the guidance even when the bot has no catalog tools yet", () => {
		const note = toolCatalogNote({
			catalog: [],
			unavailable: [],
			signInExpired: [],
			instructions: {},
			addable: [sentry],
			fromProjectAndBot: false,
			connectorsPageUrl,
		});

		expect(note).toContain(`[Connect <Name>](${connectorsPageUrl})`);
		expect(note).toContain("- Sentry (Errors and performance issues)");
	});

	it("tells the model which connectors need signing in again, each with the page of the project or bot it belongs to, apart from ones not answering", () => {
		const projectConnectorsPageUrl = "https://app.example.com/acme/projects/launch/connectors";
		const note = toolCatalogNote({
			catalog: [],
			unavailable: ["wiki"],
			signInExpired: [
				{ handle: "linear", connectorsPageUrl: projectConnectorsPageUrl },
				{ handle: "notion", connectorsPageUrl },
			],
			instructions: {},
			addable: [],
			fromProjectAndBot: false,
			connectorsPageUrl,
		});

		expect(note).toContain(
			"aren't answering right now, so their tools can't be found or run: wiki.",
		);
		expect(note).toContain("sign-ins have expired");
		expect(note).toContain(
			`linear ([Connectors](${projectConnectorsPageUrl})), notion ([Connectors](${connectorsPageUrl})).`,
		);
	});
});
