import type { ToolCallPart } from "@sugabots/contracts";
import { expect } from "storybook/test";
import preview from "#storybook/preview";
import type { ConnectionLook } from "@/lib/connections.ts";
import { ToolLine } from "./ToolLine.tsx";

const looks = new Map<string, ConnectionLook>([
	["hubspot", { name: "HubSpot" }],
	["sentry", { name: "Sentry", presetId: "sentry" }],
	["linear", { name: "Linear", presetId: "linear" }],
]);

let next = 0;
function call(tool: string, over: Partial<ToolCallPart> = {}): ToolCallPart {
	next += 1;
	return {
		type: "tool_call",
		id: `0199a3a0-0000-7000-8000-0000000003${String(next).padStart(2, "0")}`,
		tool,
		input: {},
		output: [{ id: 1 }, { id: 2 }],
		status: "completed",
		error: null,
		mutating: false,
		atOffset: 0,
		startedAt: "2026-09-25T06:04:00.000Z",
		finishedAt: "2026-09-25T06:04:01.300Z",
		...over,
	};
}

const hubspot = [
	call("hubspot__search_contacts"),
	call("hubspot__get_deal", { output: { stage: "Proposal", amount: 42000 } }),
	call("hubspot__list_emails", { finishedAt: "2026-09-25T06:04:01.600Z" }),
];

const meta = preview.meta({
	title: "Product/ToolLine",
	component: ToolLine,
	tags: ["ai-generated"],
	args: { calls: hubspot, looks },
	decorators: [
		(Story) => (
			<div className="max-w-[640px] pl-[50px]">
				<Story />
			</div>
		),
	],
});

/** Done says which apps the reply used and for how long. */
export const Done = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("button", { name: /Used HubSpot for 4s/ })).toBeVisible();
	},
});

/** Opened lists each call: the app, its tool in words, what came back and how long it took. */
export const Opened = meta.story({
	play: async ({ canvas, userEvent }) => {
		const line = canvas.getByRole("button", { name: /Used HubSpot/ });
		await userEvent.click(line);
		await expect(line).toHaveAttribute("aria-expanded", "true");
		await expect(canvas.getByText("Search contacts")).toBeVisible();
		await expect(canvas.getAllByText("2 results")).toHaveLength(2);
	},
});

/** Built-in tools answer with an object; the list gives its gist, not the raw JSON. */
export const WebSearch = meta.story({
	args: {
		calls: [
			call("web_search", {
				output: { ok: true, results: [{ url: "a" }, { url: "b" }, { url: "c" }] },
				finishedAt: "2026-09-25T06:04:02.000Z",
			}),
			call("web_fetch", {
				output: { ok: true, page: { title: "Pricing | Northwind", text: "" } },
			}),
		],
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: /Used Web search and Web fetch/ }));
		await expect(canvas.getByText("3 results")).toBeVisible();
		await expect(canvas.getByText("Pricing | Northwind")).toBeVisible();
	},
});

/** WaitingOnApproval is a reply stopped on a write; its card is below among the bubbles. */
export const WaitingOnApproval = meta.story({
	args: {
		calls: [
			call("sentry__search_issues"),
			call("linear__create_issue", {
				status: "awaiting_approval",
				mutating: true,
				finishedAt: null,
				output: null,
				approval: { status: "pending", decidedByName: null, decidedAt: null },
			}),
		],
	},
	play: async ({ canvas }) => {
		await expect(
			canvas.getByRole("button", { name: /Used Sentry, waiting on Linear approval/ }),
		).toBeVisible();
	},
});

/** Denied is a reply whose write was refused. */
export const Denied = meta.story({
	args: {
		calls: [
			call("sentry__search_issues"),
			call("linear__create_issue", {
				mutating: true,
				output: null,
				approval: { status: "denied", decidedByName: "Ryan Eyes", decidedAt: null },
			}),
		],
	},
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("button", { name: /Used Sentry, Linear denied/ })).toBeVisible();
	},
});

/** Running is a call still going. */
export const Running = meta.story({
	args: {
		calls: [call("sentry__search_issues", { status: "running", finishedAt: null, output: null })],
	},
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("button", { name: /Using Sentry/ })).toBeVisible();
	},
});

/** AFailedCall shows its error in the list, in red. */
export const AFailedCall = meta.story({
	args: {
		calls: [
			call("sentry__search_issues", { status: "failed", error: "Rate limited", output: null }),
		],
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: /Used Sentry/ }));
		await expect(canvas.getByText("Rate limited")).toBeVisible();
	},
});

/** Browser calls read as one app, the agent's browser, each step named by what it does. */
export const Browser = meta.story({
	args: {
		calls: [
			call("browser_navigate", { output: { text: "Page title: Northwind pricing" } }),
			call("browser_click", { output: { text: "Clicked Plans" } }),
		],
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: /Used Browser for/ }));
		await expect(canvas.getByText("Navigate")).toBeVisible();
		await expect(canvas.getByText("Click")).toBeVisible();
	},
});
