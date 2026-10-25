import type { MessagePart, ToolCallPart } from "@sugabots/contracts";
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
	args: { parts: hubspot, looks, fileNames: new Map() },
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
		parts: [
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
		parts: [
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
		parts: [
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
		parts: [call("sentry__search_issues", { status: "running", finishedAt: null, output: null })],
	},
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("button", { name: /Using Sentry/ })).toBeVisible();
	},
});

/** AFailedCall shows its error in the list, in red. */
export const AFailedCall = meta.story({
	args: {
		parts: [
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
		parts: [
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

function said(text: string): MessagePart {
	return { type: "text", text };
}

const SCREENSHOT_ID = "0199a3a0-0000-7000-8000-0000000004a1";

/**
 * Narrated is a reply that said what it was doing as it went: each run of
 * calls sits under its narration, and each call says what it did to what.
 */
export const Narrated = meta.story({
	args: {
		fileNames: new Map([[SCREENSHOT_ID, "sugabots-tools.png"]]),
		parts: [
			said("Let me look at the screenshot you attached:"),
			call("read_thread_file", {
				input: { file: SCREENSHOT_ID },
				output: { text: "The image sugabots-tools.png." },
			}),
			said("Checking which packages the sandbox has:"),
			call("run_command", {
				input: { command: "pip list 2>/dev/null | grep -i cadquery\nls -la" },
				output: { exitCode: 1, stdout: "", stderr: "" },
			}),
			call("run_command", {
				input: { command: "pip install cadquery", timeout_seconds: 300 },
				output: { exitCode: 0, stdout: "Successfully installed cadquery", stderr: "" },
				finishedAt: "2026-09-25T06:04:09.000Z",
			}),
			said("Now I'll log it in the feedback doc."),
			call("artifact_edit", {
				input: { artifactId: "a1", oldText: "x", newText: "y" },
				output: { status: "written", title: "Sugabots Feedback: Living Document", version: 4 },
			}),
			said("Logged it as **F-008**."),
		],
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: /Used/ }));
		await expect(canvas.getByText("Let me look at the screenshot you attached")).toBeVisible();
		await expect(canvas.getByText("sugabots-tools.png")).toBeVisible();
		await expect(canvas.getByText("pip list 2>/dev/null | grep -i cadquery")).toBeVisible();
		await expect(canvas.getByText("Exit 1")).toBeVisible();
		await expect(canvas.getByText("Sugabots Feedback: Living Document")).toBeVisible();
		await expect(canvas.queryByText(/F-008/)).toBeNull();
	},
});

/** OpenedCall shows what a call was given and what came back: a command and what it printed. */
export const OpenedCall = meta.story({
	args: Narrated.input.args,
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: /Used/ }));
		const row = canvas.getByRole("button", { name: /Ran pip install cadquery/ });
		await userEvent.click(row);
		await expect(row).toHaveAttribute("aria-expanded", "true");
		await expect(canvas.getByRole("figure", { name: "Input" })).toHaveTextContent(
			"pip install cadquery",
		);
		await expect(canvas.getByRole("figure", { name: "Output" })).toHaveTextContent(
			"Successfully installed cadquery",
		);
		// The key, to name the tool by in a bot's instructions.
		await expect(canvas.getByText("run_command")).toBeVisible();
		const input = canvas.getByRole("figure", { name: "Input" });
		await expect(input).toHaveTextContent("Timeout seconds");
		await expect(input).toHaveTextContent("300");
	},
});

/** A result too long to store whole shows the start that was kept, and says so. */
export const OutputCut = meta.story({
	args: {
		parts: [
			call("hubspot__search_contacts", {
				input: { query: "northwind" },
				output: { truncated: true, characters: 182_400, preview: '[{"id":1,"name":"Ada"' },
			}),
		],
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: /Used HubSpot/ }));
		await userEvent.click(canvas.getByRole("button", { name: /Search contacts/ }));
		await expect(
			canvas.getByText("Only the first 21 of 182,400 characters were kept."),
		).toBeVisible();
	},
});

/** A call whose input names nothing it can be shown by says what it did in general. */
export const WithoutASubject = meta.story({
	args: {
		parts: [call("read_thread_file", { input: { file: "result-file" }, output: { lines: "" } })],
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: /Used/ }));
		await expect(canvas.getByText("Read a long result")).toBeVisible();
	},
});

/**
 * AConnectionsAnswer is laid out to read: an MCP server's JSON answer as its
 * fields and items, named in words, rather than as the JSON it came in.
 */
export const AConnectionsAnswer = meta.story({
	args: {
		parts: [
			call("hubspot__search_contacts", {
				input: { query: "northwind", limit: 2, properties: ["email", "lifecyclestage"] },
				output: {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								total: 2,
								results: [
									{
										id: "5101",
										email: "ada@northwind.example",
										lifecyclestage: "customer",
										url: "https://app.hubspot.com/contacts/5101",
									},
									{ id: "5102", email: "grace@northwind.example", lifecyclestage: "lead" },
								],
							}),
						},
					],
				},
			}),
		],
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: /Used HubSpot/ }));
		await userEvent.click(canvas.getByRole("button", { name: /Search contacts/ }));
		const output = canvas.getByRole("figure", { name: "Output" });
		await expect(output).toHaveTextContent("ada@northwind.example");
		await expect(output).not.toHaveTextContent("{");
		await expect(canvas.getByText("2 results")).toBeVisible();
	},
});
