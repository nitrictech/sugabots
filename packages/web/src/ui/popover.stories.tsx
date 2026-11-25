import { Popover } from "@base-ui/react/popover";
import { expect, screen, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { Button } from "./button.tsx";
import { PopoverContent } from "./popover.tsx";

const meta = preview.meta({
	title: "Controls/PopoverContent",
	component: PopoverContent,
});

/** ProjectInfo opens a small panel beside the control that summoned it. */
export const ProjectInfo = meta.story({
	render: () => (
		<Popover.Root>
			<Popover.Trigger render={<Button variant="secondary">About Revenue</Button>} />
			<PopoverContent aria-label="About Revenue" className="max-w-64 p-4">
				<p className="m-0 text-sm">Tracks renewals and new business.</p>
			</PopoverContent>
		</Popover.Root>
	),
	play: async ({ canvas, userEvent }) => {
		await userEvent.tab();
		const trigger = canvas.getByRole("button", { name: "About Revenue" });
		await expect(trigger).toHaveFocus();
		await userEvent.keyboard("{Enter}");
		const panel = await screen.findByRole("dialog", { name: "About Revenue" });
		await waitFor(() =>
			expect(within(panel).getByText("Tracks renewals and new business.")).toBeVisible(),
		);
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "About Revenue" })).toBeNull());
		await expect(trigger).toHaveFocus();
	},
});
