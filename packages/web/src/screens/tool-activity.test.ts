import type { ToolCallPart } from "@sugabots/contracts";
import { describe, expect, it } from "vitest";
import type { ConnectionLook } from "@/lib/connections.ts";
import { toolLineText } from "./ToolLine.tsx";
import { formatDuration, formatTotal, stepLabel } from "./tool-activity.ts";

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
		mutating: false,
		atOffset: 0,
		startedAt: "2026-09-14T00:00:00.000Z",
		finishedAt: "2026-09-14T00:00:02.000Z",
		...over,
	};
}

const looks = new Map<string, ConnectionLook>([
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
	it("names each app once, and how long they took together", () => {
		expect(
			toolLineText(
				[call("hubspot__search"), call("hubspot__get_deal"), call("sentry__search")],
				looks,
			),
		).toBe("Used HubSpot and Sentry for 6s");
	});

	it("says what the reply is waiting to have approved", () => {
		expect(
			toolLineText([call("sentry__search"), call("linear__create_issue", waiting)], looks),
		).toBe("Used Sentry, waiting on Linear approval");
		expect(toolLineText([call("linear__create_issue", waiting)], looks)).toBe(
			"Waiting on Linear approval",
		);
	});

	it("says which app was refused", () => {
		const denied = {
			approval: { status: "denied" as const, decidedByName: "Ryan", decidedAt: null },
		};
		expect(
			toolLineText([call("sentry__search"), call("linear__create_issue", denied)], looks),
		).toBe("Used Sentry, Linear denied");
	});

	it("says what is still running", () => {
		expect(
			toolLineText([call("sentry__search", { status: "running", finishedAt: null })], looks),
		).toBe("Using Sentry");
	});

	it("names a built-in tool by itself, and a connection it no longer knows by its handle", () => {
		expect(toolLineText([call("web_search"), call("acme_crm__list")], looks)).toBe(
			"Used Web search and Acme crm for 4s",
		);
	});
});

describe("how tools are worded", () => {
	it("writes a call's time to a tenth, and the reply's total whole", () => {
		expect(formatDuration(473)).toBe("473ms");
		expect(formatDuration(1_400)).toBe("1.4s");
		expect(formatTotal(31_960)).toBe("32s");
		expect(formatTotal(473)).toBe("473ms");
	});

	it("turns a tool key into a phrase", () => {
		expect(stepLabel("sentry__search_issues")).toBe("Search issues");
		expect(stepLabel("linear__searchIssues")).toBe("Search issues");
		expect(stepLabel("web_fetch")).toBe("Web fetch");
	});
});
