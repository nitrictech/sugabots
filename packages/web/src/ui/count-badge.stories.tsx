import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { CountBadge } from "./count-badge.tsx";

const meta = preview.meta({
	title: "Controls/CountBadge",
	component: CountBadge,
	tags: ["ai-generated"],
	args: { count: 3, size: "md" as const, label: "3 unread messages" },
});

/** Row counts what is unread at the end of a list row, and says what it counts to a screen reader. */
export const Row = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByText("3 unread messages")).toBeInTheDocument();
	},
});

/** Tab sits beside a tab's name, such as how many approvals wait. */
export const Tab = meta.story({ args: { size: "sm", count: 2, label: "2 waiting" } });

/** Tile sits on the corner of a rail tile, whose own name says the count. */
export const Tile = meta.story({ args: { size: "lg", count: 12, label: undefined } });

/** Capped shows more than 99 as 99+. */
export const Capped = meta.story({
	args: { count: 140, label: "140 unread messages" },
	play: async ({ canvas }) => {
		await expect(canvas.getByText("99+")).toBeInTheDocument();
	},
});
