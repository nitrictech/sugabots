import { QueryClientProvider } from "@tanstack/react-query";
import { ws } from "msw";
import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { createQueryClient } from "@/lib/query.ts";
import { BrowserBar } from "./BrowserBar.tsx";

const threadId = "0199a3a0-0000-7000-8000-000000000501";
const agentId = "0199a3a0-0000-7000-8000-000000000502";
const browserSocket = ws.link(
	`${(import.meta.env.VITE_API_URL as string).replace(/^http/, "ws")}/threads/${threadId}/agents/${agentId}/desktop/tabs`,
);

const tabs = [
	{ id: "tab-docs", title: "Pricing · Example", url: "https://example.com/pricing" },
	{ id: "tab-search", title: "", url: "https://search.example/?q=competitors" },
];

const meta = preview.meta({
	title: "Product/BrowserBar",
	component: BrowserBar,
	tags: ["ai-generated"],
	args: { threadId, agentId, viewOnly: true },
	decorators: [
		(Story) => (
			<QueryClientProvider client={createQueryClient()}>
				<div className="max-w-[720px] p-4">
					<Story />
				</div>
			</QueryClientProvider>
		),
	],
});

/** The agent's browser being watched: its tabs, and the address of the one in front. */
export const Watching = meta.story({
	beforeEach({ msw }) {
		msw.use(
			browserSocket.addEventListener("connection", ({ client }) => {
				client.send(JSON.stringify({ type: "tabs", tabs, activeId: "tab-docs" }));
			}),
		);
	},
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("tab", { name: "Pricing · Example" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		await expect(canvas.getByRole("tab", { name: tabs[1]?.url })).toBeVisible();
		await expect(canvas.getByRole("textbox", { name: "Address" })).toHaveValue(
			"https://example.com/pricing",
		);
		await expect(canvas.getByRole("button", { name: "Back" })).toBeDisabled();
	},
});

/** A person in control: the address bar and the history buttons work. */
export const InControl = meta.story({
	args: { viewOnly: false },
	beforeEach: Watching.input.beforeEach,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("button", { name: "Back" })).toBeEnabled();
		await expect(canvas.getByRole("textbox", { name: "Address" })).not.toHaveAttribute("readonly");
	},
});
