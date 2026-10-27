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
const terminalChannel = desktopServer("terminal");
const filesChannel = desktopServer("files");

const windows: DisplayWindow[] = [
	{
		id: "6291458",
		kind: "browser",
		title: "Pricing · Example - Chromium",
		x: 24,
		y: 60,
		width: 620,
		height: 380,
		minimized: false,
	},
	{
		id: "18874371",
		kind: "app",
		title: "Chart preview",
		x: 360,
		y: 150,
		width: 420,
		height: 300,
		minimized: false,
	},
];
const sentToWindows = fn();

/**
 * Handlers for a desktop server with the browser and an app the agent
 * started open, and a thread folder with a file and a folder in it.
 */
const desktopServerHandlers = () => [
	windowsChannel.addEventListener("connection", ({ client }) => {
		client.send(JSON.stringify({ type: "windows", windows }));
		client.addEventListener("message", (event) => sentToWindows(JSON.parse(String(event.data))));
	}),
	terminalChannel.addEventListener("connection", ({ client }) => {
		client.send("agent@sandbox:/workspace/threads/t1$ ");
	}),
	filesChannel.addEventListener("connection", ({ client }) => {
		client.addEventListener("message", () =>
			client.send(
				JSON.stringify({
					type: "listing",
					path: "/workspace/threads/t1",
					entries: [
						{ name: "report.md", kind: "file", size: 2048, modified: "2026-10-20T09:00:00.000Z" },
						{ name: "site", kind: "folder", size: 0, modified: "2026-10-20T09:00:00.000Z" },
					],
				}),
			),
		);
	}),
];

const meta = preview.meta({
	title: "Product/AgentDesktop",
	component: AgentDesktop,
	tags: ["ai-generated"],
	args: {
		threadId,
		agent: { id: agentId, name: "Reviewer", color: "orange", face: "pill", shape: "circle" },
		viewOnly: true,
		driver: "agent",
	},
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
 * The agent's desktop being watched while the agent works, its apps told to
 * take on the viewer's light or dark look: a window for each
 * app on a display, the browser's titled by its page, and a dock whose dots
 * take the agent's colour. The windows' pages come over VNC,
 * which a preview has no sandbox for, so each says it couldn't be reached.
 */
export const Watching = meta.story({
	play: async ({ canvas }) => {
		const browser = await canvas.findByRole("region", { name: "Browser" });
		await expect(
			within(browser).getByRole("heading", { name: "Pricing · Example - Chromium" }),
		).toBeVisible();
		await expect(canvas.getByRole("region", { name: "Chart preview" })).toBeVisible();
		const dock = canvas.getByRole("navigation", { name: "Dock" });
		await expect(within(dock).getByRole("button", { name: "Chart preview" })).toBeVisible();
		const app = canvas.getByRole("region", { name: "Chart preview" });
		await expect(within(app).getByRole("button", { name: "Close" })).toBeDisabled();
		// The desktop's apps are told to look as the app does, dark in this preview.
		await waitFor(() =>
			expect(sentToWindows).toHaveBeenCalledWith({ type: "theme", scheme: "dark" }),
		);
	},
});

/**
 * A person in control: they open the terminal and the files from the dock,
 * and close the app the agent started, which the desktop server is asked to
 * do.
 */
export const InControl = meta.story({
	args: { viewOnly: false, driver: "person" },
	play: async ({ canvas, userEvent }) => {
		const dock = await canvas.findByRole("navigation", { name: "Dock" });
		await userEvent.click(within(dock).getByRole("button", { name: "Terminal" }));
		await expect(await canvas.findByRole("region", { name: "Terminal" })).toBeVisible();

		await userEvent.click(within(dock).getByRole("button", { name: "Files" }));
		const files = await canvas.findByRole("region", { name: "Files" });
		await expect(await within(files).findByRole("button", { name: /report\.md/ })).toBeVisible();

		const app = canvas.getByRole("region", { name: "Chart preview" });
		await userEvent.click(within(app).getByRole("button", { name: "Close" }));
		await waitFor(() =>
			expect(sentToWindows).toHaveBeenCalledWith({ type: "close", id: "18874371" }),
		);
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

/**
 * The browser closed, which only hides it, since the agent works in it, and
 * opened again from the dock.
 */
export const ClosingTheBrowser = meta.story({
	play: async ({ canvas, userEvent }) => {
		const browser = await canvas.findByRole("region", { name: "Browser" });
		await userEvent.click(within(browser).getByRole("button", { name: "Close" }));
		await expect(canvas.queryByRole("region", { name: "Browser" })).toBeNull();

		const dock = canvas.getByRole("navigation", { name: "Dock" });
		await userEvent.click(within(dock).getByRole("button", { name: "Browser" }));
		await expect(await canvas.findByRole("region", { name: "Browser" })).toBeVisible();
	},
});
