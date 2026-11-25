import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { createQueryClient } from "@/lib/query.ts";
import { growthDesk } from "@/shell/story-fixtures.test-support.ts";
import { DesktopScreen, DesktopStage, LiveDesktopCard } from "./DesktopViewer.tsx";

const meta = preview.meta({
	title: "Product/DesktopScreen",
	component: DesktopScreen,
	tags: ["ai-generated"],
	args: {
		chatId: "0199a3a0-0000-7000-8000-000000000501",
		botId: "0199a3a0-0000-7000-8000-000000000502",
		viewOnly: false,
		offersReconnect: true,
	},
	decorators: [
		(Story) => (
			<QueryClientProvider client={createQueryClient()}>
				<div className="max-w-180 p-4">
					<Story />
				</div>
			</QueryClientProvider>
		),
	],
});

/**
 * A desktop that can't be reached, as a preview with no computer behind it
 * always is, with a way to try again.
 */
export const Unreachable = meta.story({
	play: async ({ canvas }) => {
		await expect(await canvas.findByText(/couldn't be reached/)).toBeVisible();
		await expect(canvas.getByRole("button", { name: "Reconnect" })).toBeVisible();
	},
});

/** The bot's screen in a reply that is browsing, watch-only, opening the desktop when clicked. */
const openDesktop = fn();

export const LiveCard = meta.story({
	render: ({ chatId, botId }) => (
		<div className="max-w-115">
			<LiveDesktopCard chatId={chatId} botId={botId} botName="Growth Desk" onOpen={openDesktop} />
		</div>
	),
	play: async ({ canvas, userEvent }) => {
		await expect(canvas.getByText("Growth Desk is using its browser")).toBeVisible();
		await canvas.findByText(/couldn't be reached/);
		await expect(canvas.queryByRole("button", { name: "Reconnect" })).toBeNull();
		await userEvent.click(canvas.getByRole("button", { name: "Open Growth Desk's desktop" }));
		await expect(openDesktop).toHaveBeenCalled();
	},
});

/**
 * The desktop opened beside a chat, filling the window: the screen takes the
 * largest 4:3 shape the room above the controls allows.
 */
export const Opened = meta.story({
	parameters: { layout: "fullscreen" },
	decorators: [
		// The workspace has computers, so the bot's is shown rather than how to set one up.
		function WithComputers(Story) {
			const [client] = useState(() => {
				const queries = createQueryClient();
				queries.setQueryData(["computer-providers", undefined, "access"], { enabled: true });
				return queries;
			});
			return (
				<QueryClientProvider client={client}>
					<Story />
				</QueryClientProvider>
			);
		},
	],
	render: function Opened({ chatId }) {
		const bot = { ...growthDesk, usesComputer: true };
		return (
			<div className="fixed inset-0 flex">
				<DesktopStage chatId={chatId} owner={{ bot }} bot={bot} onClose={fn()} />
			</div>
		);
	},
	play: async ({ canvas }) => {
		await expect(canvas.getByText("Growth Desk's computer")).toBeVisible();
		await expect(await canvas.findByText(/couldn't be reached|Starting the desktop/)).toBeVisible();
	},
});
