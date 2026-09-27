import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { RailView } from "./Rail.tsx";
import { podsWithBots } from "./story-fixtures.ts";

const meta = preview.meta({
	title: "Product/Rail",
	component: RailView,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: {
		pods: podsWithBots,
		selected: "revenue",
		user: { name: "Ryan Eyes" },
		onNewPod: fn(),
	},
	decorators: [
		(Story) => (
			<div className="flex h-[640px]">
				<Story />
			</div>
		),
	],
});

/** Default is a pod chosen: its bar on the left edge, All and the other pods beside it. */
export const Default = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("link", { name: "Revenue" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		await expect(canvas.getByRole("link", { name: "All" })).not.toHaveAttribute("aria-current");
	},
});

/** All is the virtual pod chosen; its tile shows the first four pods' colours. */
export const AllChosen = meta.story({ args: { selected: "all" } });

/** Personal is chosen, below the divider. */
export const PersonalChosen = meta.story({ args: { selected: "personal" } });

/** Member has no way to make a pod, so the dashed tile is gone. */
export const Member = meta.story({
	args: { onNewPod: undefined },
	play: async ({ canvas }) => {
		await expect(canvas.queryByRole("button", { name: "New pod" })).toBeNull();
	},
});
