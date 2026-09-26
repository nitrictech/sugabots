import { expect, fn, within } from "storybook/test";
import preview from "#storybook/preview";
import { DeleteDialog } from "./delete-dialog.tsx";

const meta = preview.meta({
	title: "Patterns/DeleteDialog",
	component: DeleteDialog,
	tags: ["ai-generated"],
	args: {
		open: true,
		onOpenChange: fn(),
		onDelete: fn(),
		pending: false,
		title: "Delete Engineering?",
		description:
			"Its 2 bots, their chats, routines and connections will be deleted. This can't be undone.",
	},
});

/** DeletePod confirms an irreversible deletion with Cancel beside a red action. */
export const DeletePod = meta.story({
	play: async ({ args, canvasElement, userEvent }) => {
		const dialog = await within(canvasElement.ownerDocument.body).findByRole("dialog", {
			name: "Delete Engineering?",
		});
		await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
		await expect(args.onDelete).toHaveBeenCalled();
	},
});

/** Pending keeps both choices unavailable while the deletion is in flight. */
export const Pending = meta.story({
	args: { pending: true },
	play: async ({ canvasElement }) => {
		const dialog = await within(canvasElement.ownerDocument.body).findByRole("dialog");
		await expect(within(dialog).getByRole("button", { name: "Delete" })).toBeDisabled();
		await expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
	},
});

/** Failed says why the deletion didn't happen and leaves the dialog open to retry. */
export const Failed = meta.story({
	args: { error: "The pod could not be deleted. Try again." },
});
