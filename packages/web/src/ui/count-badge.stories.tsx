import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { CountBadge } from "./count-badge.tsx";

const meta = preview.meta({
	title: "Controls/CountBadge",
	component: CountBadge,
	tags: ["ai-generated"],
	args: { count: 2, label: "2 waiting on you" },
});

/** Waiting counts the approvals waiting on the viewer, as the phone's approvals tab shows it. */
export const Waiting = meta.story();

/** Capped shows more than 99 as 99+, and still says the full count to a screen reader. */
export const Capped = meta.story({
	args: { count: 140, label: "140 waiting on you" },
	play: async ({ canvas }) => {
		await expect(canvas.getByText("99+")).toBeInTheDocument();
		await expect(canvas.getByText("140 waiting on you")).toBeInTheDocument();
	},
});
