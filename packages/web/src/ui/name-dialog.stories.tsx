import { expect, fn, within } from "storybook/test";
import preview from "#storybook/preview";
import { Dialog } from "./dialog.tsx";
import { NameDialog } from "./name-dialog.tsx";

const meta = preview.meta({
	title: "Patterns/NameDialog",
	component: NameDialog,
	tags: ["ai-generated"],
	args: {
		title: "Rename thread",
		name: "Pricing page",
		maxLength: 80,
		placeholder: "e.g. Pricing",
		onSave: fn(async () => undefined),
	},
	render: (args) => (
		<Dialog open>
			<NameDialog {...args} />
		</Dialog>
	),
});

/** Save stays off until the name changes, and is given the new name trimmed. */
export const Rename = meta.story({
	play: async ({ args, canvasElement, userEvent }) => {
		const dialog = within(canvasElement.ownerDocument.body);
		const save = await dialog.findByRole("button", { name: "Save" });
		await expect(save).toBeDisabled();
		const field = dialog.getByRole("textbox", { name: "Name" });
		await userEvent.clear(field);
		await userEvent.type(field, "  Pricing launch ");
		await userEvent.click(save);
		await expect(args.onSave).toHaveBeenCalledWith("Pricing launch");
	},
});

/** A save that fails keeps the dialog open, saying why. */
export const SaveFails = meta.story({
	args: {
		onSave: fn(async () => {
			throw new Error("The name could not be saved.");
		}),
	},
	play: async ({ canvasElement, userEvent }) => {
		const dialog = within(canvasElement.ownerDocument.body);
		const field = await dialog.findByRole("textbox", { name: "Name" });
		await userEvent.type(field, " v2");
		await userEvent.click(dialog.getByRole("button", { name: "Save" }));
		await expect(await dialog.findByRole("alert")).toBeVisible();
	},
});
