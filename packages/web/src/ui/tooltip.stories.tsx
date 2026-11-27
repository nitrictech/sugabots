import { Info } from "lucide-react";
import { expect, screen } from "storybook/test";
import preview from "#storybook/preview";
import { IconButton } from "./icon-button.tsx";
import { Tooltip } from "./tooltip.tsx";

const meta = preview.meta({
	title: "Controls/Tooltip",
	component: Tooltip,
	tags: ["ai-generated"],
	args: { label: "Details", children: <span /> },
	render: (args) => (
		<div className="p-12">
			<Tooltip {...args}>
				<IconButton label="Details">
					<Info />
				</IconButton>
			</Tooltip>
		</div>
	),
});

/** Beneath its icon button, naming what the icon does. */
export const Below = meta.story({
	args: { defaultOpen: true },
	play: async () => {
		await expect(await screen.findByText("Details", { selector: "div" })).toBeInTheDocument();
	},
});

/** To the side, for a control at the edge of a column. */
export const Right = meta.story({
	args: { defaultOpen: true, side: "right", label: "Revenue" },
	play: async () => {
		await expect(await screen.findByText("Revenue")).toBeInTheDocument();
	},
});
