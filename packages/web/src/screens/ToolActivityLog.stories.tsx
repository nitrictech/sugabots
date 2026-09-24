import type { MessagePart, ToolCallPart } from "@sugabots/contracts";
import { expect } from "storybook/test";
import preview from "#storybook/preview";
import type { ConnectionLook } from "@/lib/connections.ts";
import { ToolActivityLog } from "./ToolActivityLog.tsx";
import { toolActivityOf } from "./tool-activity.ts";

/*
 * The times in these fixtures are fixed offsets from one instant, so every
 * duration in the catalogue reads the same on every machine. `at` is left off
 * for the same reason: it would render in the viewer's own timezone.
 */
const START = Date.parse("2026-09-18T09:00:00.000Z");

const looks = new Map<string, ConnectionLook>([
	["sentry", { name: "Sentry", presetId: "sentry", hue: 350 }],
	["linear", { name: "Linear", presetId: "linear", hue: 262 }],
]);

const names = new Map([...looks].map(([handle, look]) => [handle, look.name]));

let nextId = 0;

function call(tool: string, ms: number, over: Partial<ToolCallPart> = {}): ToolCallPart {
	nextId += 1;
	return {
		type: "tool_call",
		id: `0199a3a0-0000-7000-8000-${String(nextId).padStart(12, "0")}`,
		tool,
		input: { query: "timeout", project: "suga-prod", window: "7 days" },
		output: { issues: 3, top: "TimeoutError: upstream /billing" },
		status: "completed",
		error: null,
		mutating: false,
		atOffset: 0,
		startedAt: new Date(START).toISOString(),
		finishedAt: new Date(START + ms).toISOString(),
		...over,
	};
}

function log(...parts: MessagePart[]) {
	return toolActivityOf({ parts }, names);
}

const meta = preview.meta({
	title: "Product/ToolActivityLog",
	component: ToolActivityLog,
	tags: ["ai-generated"],
	args: { looks },
	decorators: [
		(Story) => (
			<div className="mx-auto h-[32rem] max-w-[35rem] overflow-hidden rounded-xl border border-border bg-card py-4">
				<Story />
			</div>
		),
	],
});

/** A turn that went to two services, with one tool called several times. */
export const AcrossConnections = meta.story({
	args: {
		activity: log(
			call("sentry__find_organizations", 473),
			call("sentry__find_projects", 564),
			call("sentry__search_issues", 4_700),
			call("sentry__search_issues", 4_700),
			call("sentry__search_issues", 4_700),
			call("sentry__get_resource", 15_500),
			call("linear__list_issues", 1_400),
		),
	},
});

/** A single step. */
export const OneConnection = meta.story({
	args: { activity: log(call("sentry__search_issues", 1_400)) },
});

/** The product's own tools belong to no connection, so they carry a wrench rather than a mark. */
export const BuiltInTools = meta.story({
	args: { activity: log(call("web_search", 2_100), call("web_fetch", 900)) },
});

/** The usual mixture: a service with a mark, and the product's own tools without one. */
export const BuiltInToolsBesideAConnection = meta.story({
	args: {
		activity: log(
			call("web_search", 2_100),
			call("sentry__search_issues", 4_700),
			call("web_fetch", 900),
			call("sentry__get_resource", 15_500),
		),
	},
});

/**
 * What the agent said on the way, between the steps it introduced — the same
 * run as the thread's narrated story, as the log tells it.
 */
export const WithWhatItSaid = meta.story({
	args: {
		activity: log(
			{ type: "text", text: "Let me start by finding the current cycle for the Suga Eng team:" },
			call("linear__get_team", 640),
			{ type: "text", text: "Now let me get the current cycle with the team ID:" },
			call("linear__list_cycles", 820),
			{ type: "text", text: "The current cycle is Cycle 33. Now the issues in it:" },
			call("linear__list_issues", 1_400),
			call("sentry__search_issues", 4_700),
			{ type: "text", text: "There are two high-priority issues in Cycle 33." },
		),
	},
});

/** A failure, and a refused write — the two a reader scans for. */
export const FailuresAndRefusals = meta.story({
	args: {
		activity: log(
			call("sentry__search_issues", 1_400),
			call("sentry__read_release_health", 300, {
				status: "failed",
				output: null,
				error: "The server did not answer in time",
			}),
			call("linear__create_issue", 0, {
				status: "awaiting_approval",
				output: null,
				mutating: true,
				approval: { status: "denied", decidedByName: "Ryan Eyes", decidedAt: null },
			}),
		),
	},
});

/**
 * A server that answered with a stack trace and an unbroken URL — the shape
 * that decides whether the log can hold an error or is held hostage by one.
 */
export const ALongFailure = meta.story({
	args: {
		activity: log(
			call("sentry__read_release_health", 300, {
				status: "failed",
				output: null,
				error: [
					"UpstreamError: the release health endpoint refused the request",
					"  at SentryClient.readReleaseHealth (/srv/app/node_modules/@sentry/mcp/dist/client.js:412:19)",
					"  at async ToolRunner.invoke (/srv/app/node_modules/@sugabots/core/dist/tools/runner.js:88:22)",
					"  at async Turn.step (/srv/app/node_modules/@sugabots/core/dist/turns/turn.js:233:14)",
					"request: https://sentry.example.com/api/0/organizations/suga/releases/health/?project=4471&environment=production&statsPeriod=14d&interval=1h&field=sum(session)",
				].join("\n"),
			}),
		),
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: /Read release health/ }));
	},
});

/** A failed step opens to why it failed, beside what it was given. */
export const AFailureOpened = meta.story({
	args: {
		activity: log(
			call("sentry__read_release_health", 300, {
				status: "failed",
				output: null,
				error: "The server did not answer in time",
			}),
		),
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: /Read release health/ }));
		await expect(canvas.getByText("The server did not answer in time")).toBeVisible();
	},
});

/** A step opened to what it was given and what it returned, laid out as fields and a table. */
export const AStepOpened = meta.story({
	args: {
		activity: log(
			call("sentry__search_issues", 4_700, {
				input: { query: "is:unresolved timeout", project: "suga-prod", limit: 3 },
				output: {
					issues: [
						{ id: "SUGA-1F2", title: "TimeoutError: upstream /billing", events: 212 },
						{ id: "SUGA-1C9", title: "Gateway timeout on /invoices", events: 88 },
						{ id: "SUGA-19A", title: "Slow query in usage rollup", events: 14 },
					],
					hasMore: true,
				},
			}),
			call("linear__list_issues", 1_400),
		),
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: /Search issues/ }));
		await expect(canvas.getByText("TimeoutError: upstream /billing")).toBeVisible();
	},
});

/** A `×3` row opened to its calls, each named by what set it apart, with one of them open. */
export const AFoldedStepOpened = meta.story({
	args: {
		activity: log(
			call("sentry__search_issues", 4_100, { input: { query: "timeout" } }),
			call("sentry__search_issues", 3_900, {
				input: { query: "billing" },
				output: { issues: 7, top: "Invoice total mismatch" },
			}),
			call("sentry__search_issues", 5_200, {
				input: { query: "gateway" },
				status: "failed",
				output: null,
				error: "The server did not answer in time",
			}),
		),
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: /Search issues/ }));
		await userEvent.click(canvas.getByRole("button", { name: /billing/ }));
		await expect(canvas.getByText("Invoice total mismatch")).toBeVisible();
	},
});

/** A write that went through carries a mark saying it changed something. */
export const AWriteThatChanged = meta.story({
	args: {
		activity: log(
			call("linear__list_issues", 1_400),
			call("linear__create_issue", 900, {
				mutating: true,
				input: { team: "Suga Eng", title: "Billing timeouts", priority: 2 },
				output: { id: "ENG-412", url: "https://linear.app/suga/issue/ENG-412" },
			}),
		),
	},
});

/** A fetched page: the text is cut short until asked for, so it cannot bury the log. */
export const ALongOutput = meta.story({
	args: {
		activity: log(
			call("web_fetch", 2_300, {
				input: { url: "https://docs.example.com/billing/retries" },
				output: {
					title: "Retrying failed invoices",
					text: "When an invoice fails to settle, the billing service retries it on a fixed schedule. ".repeat(
						40,
					),
				},
			}),
		),
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: /Read web pages/ }));
		await expect(canvas.getByRole("button", { name: /Show all .* characters/ })).toBeVisible();
	},
});

/** Nothing to show, which should read as a fact rather than as a broken panel. */
export const NoTools = meta.story({
	args: { activity: log({ type: "text", text: "Just words." }) },
});
