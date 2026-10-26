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
const filesChannel = desktopServer("files");

const windows: DisplayWindow[] = [
	{ id: "browser", kind: "browser", title: "Pricing · Example - Chromium" },
	{ id: "4", kind: "app", title: "Chart preview" },
];
const sentToWindows = fn();
const sentToTabs = fn();
const browserTabs = [
	{
		id: "tab-1",
		title: "Pricing · Example",
		url: "https://example.com/pricing",
		loading: false,
		canGoBack: true,
		canGoForward: false,
	},
	{
		id: "tab-2",
		title: "",
		url: "https://search.example/?q=competitors",
		loading: true,
		canGoBack: false,
		canGoForward: false,
	},
];

/**
 * Handlers for a desktop server with the browser and an app the agent
 * started open, and a thread folder with a file and a folder in it.
 */
const desktopServerHandlers = () => [
	windowsChannel.addEventListener("connection", ({ client }) => {
		client.send(JSON.stringify({ type: "windows", windows }));
		client.addEventListener("message", (event) => sentToWindows(JSON.parse(String(event.data))));
	}),
	tabsChannel.addEventListener("connection", ({ client }) => {
		client.send(JSON.stringify({ type: "tabs", tabs: browserTabs, activeId: "tab-1" }));
		client.addEventListener("message", (event) => sentToTabs(JSON.parse(String(event.data))));
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
 * app on a display, the browser's with its address bar, and a dock whose dots
 * take the agent's colour. The windows' pages come over VNC,
 * which a preview has no sandbox for, so each says it couldn't be reached.
 */
export const Watching = meta.story({
	play: async ({ canvas }) => {
		const browser = await canvas.findByRole("region", { name: "Browser" });
		await expect(await within(browser).findByRole("textbox", { name: "Address" })).toHaveValue(
			"example.com/pricing",
		);
		await expect(canvas.getByRole("region", { name: "Chart preview" })).toBeVisible();
		const dock = canvas.getByRole("navigation", { name: "Dock" });
		await expect(within(dock).getByRole("button", { name: "Chart preview" })).toBeVisible();
		const app = canvas.getByRole("region", { name: "Chart preview" });
		await expect(within(app).getByRole("button", { name: "Close" })).toBeDisabled();
		// The desktop's apps are told to look as the app does, dark in this preview.
		await waitFor(() =>
			expect(sentToWindows).toHaveBeenCalledWith({ type: "theme", scheme: "dark" }),
		);
		// Each display is sized to its window even while only watching.
		await waitFor(() =>
			expect(sentToWindows).toHaveBeenCalledWith(
				expect.objectContaining({ type: "resize", id: "browser" }),
			),
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
		await waitFor(() => expect(sentToWindows).toHaveBeenCalledWith({ type: "close", id: "4" }));
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

/**
 * The browser's tabs in control: one tab in front and one still loading,
 * switched between, closed and added to, each asked of the desktop server.
 */
export const BrowserTabs = meta.story({
	args: { viewOnly: false, driver: "person" },
	play: async ({ canvas, userEvent }) => {
		const browser = await canvas.findByRole("region", { name: "Browser" });
		const front = await within(browser).findByRole("button", { name: "Pricing · Example" });
		await expect(front).toHaveAttribute("aria-current", "true");
		await expect(within(browser).getByRole("button", { name: "Back" })).toBeEnabled();
		await expect(within(browser).getByRole("button", { name: "Forward" })).toBeDisabled();

		await userEvent.click(
			within(browser).getByRole("button", { name: "https://search.example/?q=competitors" }),
		);
		await waitFor(() =>
			expect(sentToTabs).toHaveBeenCalledWith({ type: "activate", tabId: "tab-2" }),
		);
		await userEvent.click(within(browser).getByRole("button", { name: "Close Pricing · Example" }));
		await waitFor(() =>
			expect(sentToTabs).toHaveBeenCalledWith({ type: "closeTab", tabId: "tab-1" }),
		);
		await userEvent.click(within(browser).getByRole("button", { name: "New tab" }));
		await waitFor(() => expect(sentToTabs).toHaveBeenCalledWith({ type: "newTab" }));
	},
});
