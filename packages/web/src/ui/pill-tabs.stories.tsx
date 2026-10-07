import { useState } from "react";
import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { PillTabs } from "./pill-tabs.tsx";

const tabs = [
	{ id: "waiting", label: "Waiting on you", count: 2, countLabel: "2 waiting" },
	{ id: "answered", label: "Answered" },
] as const;

type Id = (typeof tabs)[number]["id"];

function Approvals() {
	const [selected, setSelected] = useState<Id>("waiting");
	return <PillTabs label="Show" tabs={tabs} selected={selected} onSelect={setSelected} />;
}

const meta = preview.meta({
	title: "Controls/PillTabs",
	component: PillTabs,
	tags: ["ai-generated"],
	args: { label: "Show", tabs, selected: "waiting", onSelect: fn() },
	render: () => <Approvals />,
});

/** Choose shows one part of a list at a time; a tab with something in it counts it. */
export const Choose = meta.story({
	play: async ({ canvas, userEvent }) => {
		await expect(canvas.getByRole("tab", { name: /Waiting on you/ })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		await userEvent.click(canvas.getByRole("tab", { name: "Answered" }));
		await expect(canvas.getByRole("tab", { name: "Answered" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
	},
});
