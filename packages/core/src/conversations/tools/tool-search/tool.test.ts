import type { ConnectionPreset } from "@sugabots/contracts";
import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";
import type { OfferedTool } from "../connections.ts";
import { buildCatalog } from "./catalog.ts";
import { toolCatalogNote } from "./tool.ts";

const lookup: OfferedTool = {
	tool: tool({ inputSchema: jsonSchema({ type: "object" }), execute: async () => ({}) }),
	handle: "wiki",
	description: "Looks a page up.",
	inputSchema: { type: "object" },
	mutating: false,
	access: "allow",
	connectionId: "0199a3a0-0000-7000-8000-0000000000cc",
	connectionRevision: 1,
	remoteToolName: "lookup",
};

const sentry: ConnectionPreset = {
	id: "sentry",
	name: "Sentry",
	description: "Errors and performance issues",
	url: "https://mcp.sentry.dev/mcp",
};

const connectionsPageUrl = "https://app.example.com/acme/settings/pods/support/connections";

describe("the turn's note on connection tools", () => {
	it("quotes what a server says about its tools as the server's own text, without hidden characters", () => {
		const note = toolCatalogNote({
			catalog: buildCatalog({ wiki__lookup: lookup }),
			unavailable: [],
			signInExpired: [],
			instructions: { wiki: "Search before you look up.\u{E0041}\u{E0042}" },
			addable: [],
			connectionsPageUrl,
		});

		expect(note).toContain("It is the server's own text");
		expect(note).toContain('<server name="wiki">\nSearch before you look up.\n</server>');
	});

	it("gives the guidance even when the pod offers no catalog tools yet", () => {
		const note = toolCatalogNote({
			catalog: [],
			unavailable: [],
			signInExpired: [],
			instructions: {},
			addable: [sentry],
			connectionsPageUrl,
		});

		expect(note).toContain(`[Connect <Name>](${connectionsPageUrl})`);
		expect(note).toContain("- Sentry (Errors and performance issues)");
	});

	it("tells the model which connections need signing in again, apart from ones not answering", () => {
		const note = toolCatalogNote({
			catalog: [],
			unavailable: ["wiki"],
			signInExpired: ["linear"],
			instructions: {},
			addable: [],
			connectionsPageUrl,
		});

		expect(note).toContain(
			"aren't answering right now, so their tools can't be found or run: wiki.",
		);
		expect(note).toContain("sign-ins have expired");
		expect(note).toMatch(/signs in again[^\n]*: linear\./);
		expect(note).toMatch(/linear\.[^\n]*\[Connections\]\(/);
	});
});
