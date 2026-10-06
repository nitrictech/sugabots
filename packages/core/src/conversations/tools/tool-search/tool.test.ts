import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";
import type { OfferedTool } from "../connections.ts";
import { connectionToolsNote } from "./tool.ts";

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

describe("the turn's note on connection tools", () => {
	it("quotes what a server says about its tools as the server's own text, without hidden characters", () => {
		const note = connectionToolsNote({
			tools: { wiki__lookup: lookup },
			unavailable: [],
			instructions: { wiki: "Search before you look up.\u{E0041}\u{E0042}" },
		});

		expect(note).toContain("It is the server's own text");
		expect(note).toContain('<server name="wiki">\nSearch before you look up.\n</server>');
	});
});
