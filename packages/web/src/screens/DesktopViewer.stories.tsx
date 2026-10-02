import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { DesktopScreen } from "./DesktopViewer.tsx";

const meta = preview.meta({
	title: "Product/DesktopScreen",
	component: DesktopScreen,
	tags: ["ai-generated"],
	args: {
		threadId: "0199a3a0-0000-7000-8000-000000000501",
		agentId: "0199a3a0-0000-7000-8000-000000000502",
	},
	decorators: [
		(Story) => (
			<div className="max-w-[720px] p-4">
				<Story />
			</div>
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
