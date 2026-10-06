import type { ConnectionAccess } from "@sugabots/contracts";
import { jsonSchema, type Tool, tool } from "ai";
import { describe, expect, it } from "vitest";
import type { OfferedTool } from "../tools/connections.ts";
import { CALL_TOOL, TOOL_SEARCH } from "../tools/tool-search/tool.ts";
import { connectionOfferFitting } from "./connection-offer.ts";
import { directToolDefinitionsLimitTokens } from "./context-window.ts";

const WINDOW_TOKENS = 128_000;

/** A tool whose definition is about `tokens` tokens long. */
function offered(name: string, access: ConnectionAccess, tokens = 50): OfferedTool {
	const inputSchema = {
		type: "object" as const,
		properties: { page: { type: "string" as const } },
	};
	return {
		tool: tool({ inputSchema: jsonSchema(inputSchema), execute: async () => ({}) }),
		handle: "wiki",
		description: "x".repeat(tokens * 4),
		inputSchema,
		mutating: access === "ask",
		access,
		connectionId: "0199a3a0-0000-7000-8000-0000000000cc",
		connectionRevision: 1,
		remoteToolName: name,
	};
}

/** The tools the model is sent, given each connection tool as the turn runs it. */
const sentTools = (offer: ReturnType<typeof connectionOfferFitting>) =>
	Object.keys(
		offer.toolsFor(
			Object.fromEntries(Object.entries(offer.tools).map(([key, { tool }]) => [key, tool as Tool])),
			(_, recorded) => recorded,
		),
	);

describe("how a turn offers its pod's connection tools", () => {
	it("offers tools that fit as tools of their own, naming them and asking first where they must", () => {
		const offer = connectionOfferFitting(
			{ wiki__lookup: offered("lookup", "allow"), wiki__wipe: offered("wipe", "ask") },
			WINDOW_TOKENS,
		);

		expect(sentTools(offer)).toEqual(["wiki__lookup", "wiki__wipe"]);
		expect(offer.note).toContain("connections you can call: wiki__lookup, wiki__wipe.");
		expect(offer.toolApproval).toEqual({ wiki__wipe: "user-approval" });
	});

	it("bridges tools whose definitions would take more than their share of the window", () => {
		const share = directToolDefinitionsLimitTokens(WINDOW_TOKENS);
		const fitting = connectionOfferFitting(
			{ wiki__lookup: offered("lookup", "allow", share - 100) },
			WINDOW_TOKENS,
		);
		const crowding = connectionOfferFitting(
			{ wiki__lookup: offered("lookup", "allow", share + 100) },
			WINDOW_TOKENS,
		);

		expect(fitting.mode).toBe("direct");
		expect(crowding.mode).toBe("bridged");
		expect(sentTools(crowding)).toEqual([TOOL_SEARCH, CALL_TOOL]);
		expect(crowding.note).toContain("- wiki (1 tool): wiki__lookup");
	});

	it("asks a person first for a bridged call only when the tool it names asks first", () => {
		const share = directToolDefinitionsLimitTokens(WINDOW_TOKENS);
		const offer = connectionOfferFitting(
			{ wiki__lookup: offered("lookup", "allow", share), wiki__wipe: offered("wipe", "ask") },
			WINDOW_TOKENS,
		);
		const approval = (offer.toolApproval as Record<string, (input: unknown) => unknown>)[CALL_TOOL];

		expect(approval?.({ tool: "wiki__wipe", arguments: {} })).toBe("user-approval");
		expect(approval?.({ tool: "wiki__lookup", arguments: {} })).toBeUndefined();
		expect(approval?.({ tool: "constructor", arguments: {} })).toBeUndefined();
	});

	it("says nothing of connection tools when the pod has none", () => {
		expect(connectionOfferFitting({}, WINDOW_TOKENS).note).toBeUndefined();
	});
});
