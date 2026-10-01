import { Info } from "lucide-react";
import { expect, screen } from "storybook/test";
import preview from "#storybook/preview";
import { IconButton } from "./icon-button.tsx";
import { DetailTooltip, Tooltip } from "./tooltip.tsx";

const meta = preview.meta({
	title: "Controls/Tooltip",
	component: Tooltip,
	tags: ["ai-generated"],
	args: { label: "Details", children: <span /> },
	render: (args) => (
		<div style={{ padding: 48 }}>
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

/** To the side, as the rail's tiles show their pod's name. */
export const Right = meta.story({
	args: { defaultOpen: true, side: "right", label: "Revenue" },
	play: async () => {
		await expect(await screen.findByText("Revenue")).toBeInTheDocument();
	},
});

/**
 * A title and how to change it, lined up with the start of its control, as
 * the composer's people-only toggle explains itself.
 */
export const Detail = meta.story({
	render: () => (
		<div style={{ padding: 48, paddingTop: 96 }}>
			<DetailTooltip
				defaultOpen
				side="top"
				align="start"
				title="Growth Desk replies"
				description="Tab or click to message people only."
			>
				<IconButton label="People only">
					<Info />
				</IconButton>
			</DetailTooltip>
		</div>
	),
	play: async () => {
		await expect(await screen.findByText("Growth Desk replies")).toBeInTheDocument();
		await expect(screen.getByText("Tab or click to message people only.")).toBeInTheDocument();
	},
});
