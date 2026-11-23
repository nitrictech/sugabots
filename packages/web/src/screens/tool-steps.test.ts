import type { ToolCallPart } from "@sugabots/contracts";
import { describe, expect, it } from "vitest";
import type { MarkedConnector } from "@/lib/connectors.ts";
import { toolLineText } from "./tool-steps.ts";

let nextId = 0;

function call(tool: string, over: Partial<ToolCallPart> = {}): ToolCallPart {
	nextId += 1;
	return {
		type: "tool_call",
		id: `0199a3a0-0000-7000-8000-${String(nextId).padStart(12, "0")}`,
		tool,
		input: {},
		output: { ok: true },
		status: "completed",
		error: null,
		writeOrDelete: false,
		atOffset: 0,
		startedAt: "2026-09-14T00:00:00.000Z",
		finishedAt: "2026-09-14T00:00:02.000Z",
		...over,
	};
}

const markedConnectors = new Map<string, MarkedConnector>([
	["sentry", { name: "Sentry" }],
	["linear", { name: "Linear" }],
	["hubspot", { name: "HubSpot" }],
]);

const waiting = {
	status: "awaiting_approval" as const,
	finishedAt: null,
	approval: { status: "pending" as const, decidedByName: null, decidedAt: null },
};

describe("a reply's tool line", () => {
	it("names each tool source once, and how long they took together", () => {
		expect(
			toolLineText(
				[call("hubspot__search"), call("hubspot__get_deal"), call("sentry__search")],
				markedConnectors,
			),
		).toBe("Used HubSpot and Sentry for 6s");
	});

	it("gives a sub-second total in milliseconds, and a longer one in whole seconds", () => {
		expect(
			toolLineText(
				[call("sentry__search", { finishedAt: "2026-09-14T00:00:00.473Z" })],
				markedConnectors,
			),
		).toBe("Used Sentry for 473ms");
		expect(
			toolLineText(
				[call("sentry__search", { finishedAt: "2026-09-14T00:00:31.960Z" })],
				markedConnectors,
			),
		).toBe("Used Sentry for 32s");
	});

	it("says what the reply is waiting to have approved", () => {
		expect(
			toolLineText(
				[call("sentry__search"), call("linear__create_issue", waiting)],
				markedConnectors,
			),
		).toBe("Used Sentry, waiting on Linear approval");
		expect(toolLineText([call("linear__create_issue", waiting)], markedConnectors)).toBe(
			"Waiting on Linear approval",
		);
	});

	it("says which tool source was refused", () => {
		const denied = {
			approval: { status: "denied" as const, decidedByName: "Rowan", decidedAt: null },
		};
		expect(
			toolLineText(
				[call("sentry__search"), call("linear__create_issue", denied)],
				markedConnectors,
			),
		).toBe("Used Sentry, Linear denied");
	});

	it("says what is still running", () => {
		expect(
			toolLineText(
				[call("sentry__search", { status: "running", finishedAt: null })],
				markedConnectors,
			),
		).toBe("Using Sentry");
	});

	it("names a built-in tool by itself, and a connector it no longer knows by its handle", () => {
		expect(toolLineText([call("web_search"), call("acme_crm__list")], markedConnectors)).toBe(
			"Used Web search and Acme crm for 4s",
		);
	});

	it("names the file tools together, as one tool source", () => {
		expect(
			toolLineText([call("file_edit"), call("file_read"), call("file_write")], markedConnectors),
		).toBe("Used Files for 6s");
	});
});
