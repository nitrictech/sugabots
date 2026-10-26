import { QueryClientProvider } from "@tanstack/react-query";
import { ws } from "msw";
import { expect, fn, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { createQueryClient } from "@/lib/query.ts";
import { AgentDesktop, type DisplayWindow } from "./Desktop.tsx";

const threadId = "0199a3a0-0000-7000-8000-000000000501";
const agentId = "0199a3a0-0000-7000-8000-000000000502";
const desktopServer = (channel: string) =>
	ws.link(
		`${(import.meta.env.VITE_API_URL as string).replace(/^http/, "ws")}/threads/${threadId}/agents/${agentId}/desktop/${channel}`,
	);
const windowsChannel = desktopServer("windows");
const tabsChannel = desktopServer("tabs");
const terminalChannel = desktopServer("terminal");

const windows: DisplayWindow[] = [
	{ id: "browser", kind: "browser", title: "Pricing · Example - Chromium" },
	{ id: "files", kind: "files", title: "threads" },
	{ id: "4", kind: "app", title: "Chart preview" },
];
const sentToWindows = fn();

/** Handlers for a desktop server with the browser, the file manager and an app the agent started open. */
const desktopServerHandlers = () => [
	windowsChannel.addEventListener("connection", ({ client }) => {
		client.send(JSON.stringify({ type: "windows", windows }));
		client.addEventListener("message", (event) => sentToWindows(JSON.parse(String(event.data))));
	}),
	tabsChannel.addEventListener("connection", ({ client }) => {
		client.send(
			JSON.stringify({
				type: "tabs",
				tabs: [{ id: "tab-1", title: "Pricing · Example", url: "https://example.com/pricing" }],
				activeId: "tab-1",
			}),
		);
	}),
	terminalChannel.addEventListener("connection", ({ client }) => {
		client.send("agent@sandbox:/workspace/threads/t1$ ");
	}),
];

const meta = preview.meta({
	title: "Product/AgentDesktop",
	component: AgentDesktop,
	tags: ["ai-generated"],
	args: { threadId, agentId, viewOnly: true },
	beforeEach({ msw }) {
		msw.use(...desktopServerHandlers());
	},
	decorators: [
		(Story) => (
			<QueryClientProvider client={createQueryClient()}>
				<div className="flex h-[600px] flex-col p-4">
					<Story />
				</div>
			</QueryClientProvider>
		),
	],
});

/**
 * The agent's desktop being watched: a window for each app, the browser's
 * with its tabs, and a dock. The windows' pages come over VNC, which a
 * preview has no sandbox for, so each says it couldn't be reached.
 */
export const Watching = meta.story({
	play: async ({ canvas }) => {
		const browser = await canvas.findByRole("region", { name: "Browser" });
		await expect(
			await within(browser).findByRole("tab", { name: "Pricing · Example" }),
		).toBeVisible();
		await expect(canvas.getByRole("region", { name: "Files: threads" })).toBeVisible();
		await expect(canvas.getByRole("region", { name: "Chart preview" })).toBeVisible();
		const dock = canvas.getByRole("navigation", { name: "Dock" });
		await expect(within(dock).getByRole("button", { name: "Chart preview" })).toBeVisible();
		await expect(canvas.queryByRole("button", { name: "Close" })).toBeNull();
	},
});

/**
 * A person in control: they open the terminal from the dock, and close the
 * file manager, which the desktop server is asked to do.
 */
export const InControl = meta.story({
	args: { viewOnly: false },
	play: async ({ canvas, userEvent }) => {
		const dock = await canvas.findByRole("navigation", { name: "Dock" });
		await userEvent.click(within(dock).getByRole("button", { name: "Terminal" }));
		await expect(await canvas.findByRole("region", { name: "Terminal" })).toBeVisible();

		const files = await canvas.findByRole("region", { name: "Files: threads" });
		await userEvent.click(within(files).getByRole("button", { name: "Close" }));
		await waitFor(() => expect(sentToWindows).toHaveBeenCalledWith({ type: "close", id: "files" }));
	},
});

/** A window tucked into the dock, and brought back from it. */
export const Minimizing = meta.story({
	play: async ({ canvas, userEvent }) => {
		const app = await canvas.findByRole("region", { name: "Chart preview" });
		await userEvent.click(within(app).getByRole("button", { name: "Minimize" }));
		await expect(canvas.queryByRole("region", { name: "Chart preview" })).toBeNull();

		const dock = canvas.getByRole("navigation", { name: "Dock" });
		await userEvent.click(within(dock).getByRole("button", { name: "Chart preview" }));
		await expect(await canvas.findByRole("region", { name: "Chart preview" })).toBeVisible();
	},
});
