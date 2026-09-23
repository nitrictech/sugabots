import type { MessagePart, ToolCallPart } from "@sugabots/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ConnectionLook } from "@/lib/connections.ts";
import { ToolActivityLog } from "./ToolActivityLog.tsx";
import { toolActivityOf } from "./tool-activity.ts";

const looks = new Map<string, ConnectionLook>([
	["sentry", { name: "Sentry", presetId: "sentry", hue: 350 }],
	["linear", { name: "Linear", presetId: "linear", hue: 262 }],
]);

let nextId = 0;

function toolCall(tool: string, over: Partial<ToolCallPart> = {}): ToolCallPart {
	nextId += 1;
	return {
		type: "tool_call",
		id: `0199a3a0-0000-7000-8000-${String(nextId).padStart(12, "0")}`,
		tool,
		input: { query: "timeout", limit: 3 },
		output: { found: 3 },
		status: "completed",
		error: null,
		mutating: false,
		atOffset: 0,
		startedAt: "2026-09-18T09:00:00.000Z",
		finishedAt: "2026-09-18T09:00:01.400Z",
		...over,
	};
}

function show(...calls: MessagePart[]) {
	const activity = toolActivityOf(
		{ parts: calls },
		new Map([...looks].map(([h, l]) => [h, l.name])),
	);
	return render(
		<ToolActivityLog activity={activity} looks={looks} at="2026-09-18T09:00:02.000Z" />,
	);
}

afterEach(cleanup);

describe("the activity log", () => {
	it("says how many steps there were, and how long the turn took", () => {
		show(toolCall("sentry__search_issues"), toolCall("linear__list_issues"));

		// The roll-up only: which connections were used is each step's mark to say.
		expect(screen.getByText(/^2 steps · /)).toBeDefined();
		expect(screen.queryByText(/across/)).toBeNull();
		expect(screen.getByText(/· 3s ·/)).toBeDefined();
	});

	it("reads what the agent said and the steps it took, in order, folding repeats", () => {
		show(
			{ type: "text", text: "Let me search Sentry:" },
			toolCall("sentry__search_issues"),
			toolCall("sentry__search_issues"),
			toolCall("sentry__search_issues"),
			{ type: "text", text: "Now the matching Linear issues:" },
			toolCall("linear__list_issues"),
			{ type: "text", text: "The answer, which the thread shows instead." },
		);

		const [search, list] = screen.getAllByRole("listitem");
		expect(search?.textContent).toMatch(/Sentry · Search issues×34\.2s/);
		expect(list?.textContent).toMatch(/Linear · List issues1\.4s/);
		expect(
			screen
				.getByText("Let me search Sentry:")
				.compareDocumentPosition(screen.getByText("Now the matching Linear issues:")),
		).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
		expect(screen.queryByText(/The answer/)).toBeNull();
	});

	it("states what a step did without opening into anything", () => {
		show(toolCall("sentry__search_issues"), toolCall("sentry__search_issues"));

		// The row is read, not operated: the `×2` says how many there were, and
		// what a call was given has no presentation here yet.
		expect(screen.getByText("×2")).toBeDefined();
		expect(screen.queryByRole("button", { expanded: false })).toBeNull();
		expect(screen.queryByText("query: timeout")).toBeNull();
		expect(screen.queryByRole("button", { name: "Raw" })).toBeNull();
	});

	it("opens a failed step to its reason, and says nothing about failing on the row", () => {
		show(
			toolCall("sentry__read_release_health", {
				status: "failed",
				output: null,
				error: "The server did not answer in time",
			}),
		);

		// The row is red and opens; it does not also carry the word.
		expect(screen.queryByText(/failed/)).toBeNull();
		expect(screen.queryByText("The server did not answer in time")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /Read release health/ }));
		expect(screen.getByText("The server did not answer in time")).toBeDefined();
	});

	it("ends every row with its duration, so the times line up whatever opens", () => {
		show(
			toolCall("sentry__search_issues"),
			toolCall("sentry__read_release_health", { status: "failed", output: null, error: "Gone" }),
		);

		// The disclosure leads the row; nothing comes after the time on any of them.
		for (const row of screen.getAllByRole("listitem")) {
			expect(row.textContent?.trimEnd()).toMatch(/\d(ms|s)$/);
		}
	});

	it("keeps a multi-line reason whole, and able to break mid-path", () => {
		const trace = [
			"UpstreamError: the endpoint refused the request",
			"  at SentryClient.read (/srv/app/node_modules/@sentry/mcp/dist/client.js:412:19)",
		].join("\n");
		show(toolCall("sentry__read", { status: "failed", output: null, error: trace }));

		fireEvent.click(screen.getByRole("button", { name: /Read/ }));
		const block = screen.getByText(trace, { collapseWhitespace: false });

		// Every line is kept, and nothing about it may clip: a path with no spaces
		// in it ran off the right edge before `overflow-wrap` was set.
		expect(block.textContent).toBe(trace);
		expect(block.className).toMatch(/whitespace-pre-wrap/);
		expect(block.className).toMatch(/overflow-wrap:anywhere/);
	});

	it("says so when a failure recorded no reason at all", () => {
		show(toolCall("sentry__read_release_health", { status: "failed", output: null, error: null }));

		fireEvent.click(screen.getByRole("button", { name: /Read release health/ }));
		expect(screen.getByText("No reason was recorded.")).toBeDefined();
	});

	it("leaves a step that returned nothing reading like any other", () => {
		show(toolCall("sentry__list_projects", { output: null }));

		expect(screen.getByText("List projects")).toBeDefined();
		expect(screen.queryByText(/no data returned/)).toBeNull();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("says a refused write never ran, which nothing else on its row shows", () => {
		show(
			toolCall("linear__create_issue", {
				status: "awaiting_approval",
				output: null,
				mutating: true,
				approval: { status: "denied", decidedByName: "Ryan Eyes", decidedAt: null },
			}),
		);

		expect(screen.getByText(/not run/)).toBeDefined();
	});

	it("says which connection each step went to, and the product's own tools as its own", () => {
		show(toolCall("web_search"), toolCall("sentry__search_issues"));

		const [search, issues] = screen.getAllByRole("listitem");
		expect(within(search as HTMLElement).getByText("Built-in tools ·")).toBeDefined();
		expect(within(issues as HTMLElement).getByText("Sentry ·")).toBeDefined();
	});

	it("says plainly when a reply used no tools at all", () => {
		show({ type: "text", text: "Just words." });

		expect(screen.getByText("This reply used no tools.")).toBeDefined();
	});
});
