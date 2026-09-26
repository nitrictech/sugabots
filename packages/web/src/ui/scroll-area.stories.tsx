import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { ScrollArea } from "./scroll-area.tsx";

const LINES = Array.from({ length: 40 }, (_, index) => `Line ${index + 1} of the request`);

const meta = preview.meta({
	title: "Controls/ScrollArea",
	component: ScrollArea,
	tags: ["ai-generated"],
	render: () => (
		<ScrollArea style={{ height: 220, width: 320 }} className="rounded-panel bg-list">
			<div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 6 }}>
				{LINES.map((line) => (
					<p key={line} style={{ margin: 0, fontSize: 14 }}>
						{line}
					</p>
				))}
			</div>
		</ScrollArea>
	),
});

/** More than fits: it scrolls, with a thin scrollbar laid over it rather than a gutter. */
export const Overflowing = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByText("Line 40 of the request")).toBeInTheDocument();
	},
});
