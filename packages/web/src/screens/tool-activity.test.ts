import type { MessagePart, ToolCallPart } from "@sugabots/contracts";
import { describe, expect, it } from "vitest";
import type { ActivityStep, ToolActivity } from "./tool-activity.ts";
import {
	formatDuration,
	formatTotal,
	stepErrors,
	stepLabel,
	toolActivityOf,
} from "./tool-activity.ts";

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
		finishedAt: "2026-09-14T00:00:01.000Z",
		...over,
	};
}

/** A call that took `ms`, so a row's summed duration is worth asserting on. */
function lasting(tool: string, ms: number, over: Partial<ToolCallPart> = {}): ToolCallPart {
	return call(tool, {
		startedAt: "2026-09-14T00:00:00.000Z",
		finishedAt: new Date(Date.parse("2026-09-14T00:00:00.000Z") + ms).toISOString(),
		...over,
	});
}

function message(...parts: MessagePart[]) {
	return { parts };
}

function stepsOf(activity: ToolActivity): ActivityStep[] {
	return activity.entries.flatMap((entry) => (entry.type === "step" ? [entry.step] : []));
}

function onlyStep(activity: ToolActivity) {
	return stepsOf(activity).at(0);
}

describe("a turn's tool activity", () => {
	it("reads in the order it happened, with what was said before each step", () => {
		const activity = toolActivityOf(
			message(
				{ type: "text", text: "Let me find the project:" },
				call("sentry__find_projects"),
				call("linear__list_issues"),
				{ type: "text", text: "Now the issues in it:" },
				call("sentry__search_issues"),
				{ type: "text", text: "Here they are." },
			),
		);

		expect(
			activity.entries.map((entry) => (entry.type === "said" ? entry.text : entry.step.tool)),
		).toEqual([
			"Let me find the project:",
			"sentry__find_projects",
			"linear__list_issues",
			"Now the issues in it:",
			"sentry__search_issues",
		]);
	});

	it("folds back-to-back calls to the same tool into one row that counts them", () => {
		const activity = toolActivityOf(
			message(
				lasting("sentry__get_resource", 1_000),
				lasting("sentry__get_resource", 2_000),
				lasting("sentry__search_issues", 4_000),
				lasting("sentry__get_resource", 500),
			),
		);

		expect(stepsOf(activity).map((step) => [step.tool, step.count, step.durationMs])).toEqual([
			["sentry__get_resource", 2, 3_000],
			["sentry__search_issues", 1, 4_000],
			["sentry__get_resource", 1, 500],
		]);
		// Steps are calls, not rows: the two folded reads still count as two.
		expect(activity.stepCount).toBe(4);
		expect(activity.durationMs).toBe(7_500);
	});

	it("names the product's own tools from the catalog, as no connection's", () => {
		const activity = toolActivityOf(message(call("web_search"), call("sentry__search_issues")));

		expect(stepsOf(activity).map((step) => [step.label, step.connection])).toEqual([
			["Search the web", "Built-in tools"],
			["Search issues", "Sentry"],
		]);
	});

	it("takes a connection's display name when it is known, and writes out the handle when it is not", () => {
		const activity = toolActivityOf(
			message(call("sentry__search_issues"), call("acme_crm__list_deals")),
			new Map([["sentry", "Sentry"]]),
		);

		expect(stepsOf(activity).map((step) => step.connection)).toEqual(["Sentry", "Acme crm"]);
	});

	it("reports the worst thing that happened in a folded row", () => {
		const ok = toolActivityOf(message(call("sentry__a")));
		const failed = toolActivityOf(
			message(call("sentry__a"), call("sentry__a", { status: "failed", output: null })),
		);
		const denied = toolActivityOf(
			message(
				call("linear__create_issue", {
					status: "awaiting_approval",
					output: null,
					approval: { status: "denied", decidedByName: "Ryan", decidedAt: null },
				}),
			),
		);

		expect(onlyStep(ok)?.outcome).toBe("ok");
		expect(onlyStep(failed)?.outcome).toBe("error");
		expect(onlyStep(denied)?.outcome).toBe("skipped");
	});

	it("does not judge a step by what it returned: running and returning nothing both read as ok", () => {
		expect(onlyStep(toolActivityOf(message(call("sentry__a", { output: null }))))?.outcome).toBe(
			"ok",
		);
		expect(onlyStep(toolActivityOf(message(call("sentry__a", { output: [] }))))?.outcome).toBe(
			"ok",
		);
	});

	it("picks out the newest call, and when the first one started, for the live line", () => {
		const activity = toolActivityOf(
			message(
				call("sentry__search_issues", { startedAt: "2026-09-14T00:00:00.000Z" }),
				call("sentry__read", {
					status: "running",
					output: null,
					startedAt: "2026-09-14T00:00:05.000Z",
					finishedAt: null,
				}),
			),
		);

		expect(activity.latest?.tool).toBe("sentry__read");
		expect(activity.startedAt).toBe("2026-09-14T00:00:00.000Z");
		expect(toolActivityOf(message({ type: "text", text: "Just words." })).latest).toBeUndefined();
	});

	it("has nothing in it for a reply that called nothing", () => {
		const activity = toolActivityOf(message({ type: "text", text: "Just words." }));

		expect(activity.entries).toEqual([]);
		expect(activity.stepCount).toBe(0);
	});
});

describe("how activity is worded", () => {
	it("writes a step's time to a tenth, and the turn's total whole", () => {
		expect(formatDuration(473)).toBe("473ms");
		expect(formatDuration(1_400)).toBe("1.4s");
		expect(formatDuration(30_600)).toBe("30.6s");

		expect(formatTotal(32_000)).toBe("32s");
		expect(formatTotal(31_960)).toBe("32s");
		expect(formatTotal(473)).toBe("473ms");
	});

	it("gathers a failed row's reasons, once each", () => {
		const activity = toolActivityOf(
			message(
				call("sentry__read", { status: "failed", output: null, error: "Timed out" }),
				call("sentry__read", { status: "failed", output: null, error: "Timed out" }),
				call("sentry__read", { status: "failed", output: null, error: "Host is down" }),
			),
		);

		expect(onlyStep(activity)?.count).toBe(3);
		expect(stepErrors(onlyStep(activity) as ActivityStep)).toEqual(["Timed out", "Host is down"]);
	});

	it("has no reasons to show when a failure recorded none", () => {
		const activity = toolActivityOf(
			message(call("sentry__read", { status: "failed", output: null, error: null })),
		);

		expect(stepErrors(onlyStep(activity) as ActivityStep)).toEqual([]);
	});

	it("turns a tool key into a phrase", () => {
		expect(stepLabel("sentry__search_issues")).toBe("Search issues");
		expect(stepLabel("linear__searchIssues")).toBe("Search issues");
		expect(stepLabel("web_fetch")).toBe("Read web pages");
	});
});
