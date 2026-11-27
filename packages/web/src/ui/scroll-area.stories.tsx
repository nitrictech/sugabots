import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { ScrollArea } from "./scroll-area.tsx";

const LINES = Array.from({ length: 40 }, (_, index) => `Line ${index + 1} of the request`);

const meta = preview.meta({
	title: "Controls/ScrollArea",
	component: ScrollArea,
	tags: ["ai-generated"],
	render: () => (
		<ScrollArea className="h-55 w-80 rounded-panel bg-list">
			<div className="flex flex-col gap-1.5 p-4">
				{LINES.map((line) => (
					<p key={line} className="m-0 text-sm">
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
