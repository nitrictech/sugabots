import { QueryClientProvider } from "@tanstack/react-query";
import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { createQueryClient } from "@/lib/query.ts";
import { DesktopScreen, LiveDesktopCard } from "./DesktopViewer.tsx";

const meta = preview.meta({
	title: "Product/DesktopScreen",
	component: DesktopScreen,
	tags: ["ai-generated"],
	args: {
		threadId: "0199a3a0-0000-7000-8000-000000000501",
		agentId: "0199a3a0-0000-7000-8000-000000000502",
		viewOnly: false,
	},
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

/**
 * A desktop that can't be reached, as a preview with no sandbox behind it
 * always is: the view says to open it again.
 */
export const Unreachable = meta.story({
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText(/couldn't be reached/, {}, { timeout: 10_000 }),
		).toBeVisible();
	},
});

/** The agent's screen in a reply that is browsing, watch-only, opening the desktop when clicked. */
const openDesktop = fn();

export const LiveCard = meta.story({
	render: ({ threadId, agentId }) => (
		<div className="max-w-[460px]">
			<LiveDesktopCard
				threadId={threadId}
				agentId={agentId}
				agentName="Growth Desk"
				onOpen={openDesktop}
			/>
		</div>
	),
	play: async ({ canvas, userEvent }) => {
		await expect(canvas.getByText("Growth Desk is using its browser")).toBeVisible();
		await userEvent.click(canvas.getByRole("button", { name: "Open Growth Desk's desktop" }));
		await expect(openDesktop).toHaveBeenCalled();
	},
});
