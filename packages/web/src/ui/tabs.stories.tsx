import { expect, waitFor } from "storybook/test";
import preview from "#storybook/preview";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs.tsx";

const meta = preview.meta({
	title: "Controls/Tabs",
	component: Tabs,
	tags: ["ai-generated"],
	render: () => (
		<Tabs defaultValue="shape" className="gap-3">
			<TabsList aria-label="Part">
				<TabsTrigger value="shape">Shape</TabsTrigger>
				<TabsTrigger value="eyes">Eyes</TabsTrigger>
			</TabsList>
			<TabsContent value="shape" className="text-sm">
				Every head shape.
			</TabsContent>
			<TabsContent value="eyes" className="text-sm">
				Every pair of eyes.
			</TabsContent>
		</Tabs>
	),
});

/** Choosing a tab shows its panel, as an avatar's Shape and Eyes do. */
export const Choose = meta.story({
	play: async ({ canvas, userEvent }) => {
		await expect(canvas.getByRole("tabpanel")).toHaveTextContent("Every head shape.");
		await userEvent.click(canvas.getByRole("tab", { name: "Eyes" }));
		await expect(canvas.getByRole("tab", { name: "Eyes" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		// The chosen panel replaces the other once the change has played out.
		await waitFor(() =>
			expect(canvas.getByRole("tabpanel")).toHaveTextContent("Every pair of eyes."),
		);
	},
});

/** The arrow keys move between tabs. */
export const Keyboard = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.tab();
		await expect(canvas.getByRole("tab", { name: "Shape" })).toHaveFocus();
		await userEvent.keyboard("{ArrowRight}");
		await expect(canvas.getByRole("tab", { name: "Eyes" })).toHaveFocus();
	},
});
