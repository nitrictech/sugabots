import { expect, fn, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { Button } from "./button.tsx";
import { Dialog, DialogClose, DialogDescription, DialogTitle, DialogTrigger } from "./dialog.tsx";
import { DialogForm, DialogFormBody, DialogFormFooter } from "./dialog-form.tsx";
import { Field } from "./field.tsx";
import { Input } from "./input.tsx";
import { SurfaceHeader, SurfaceTitle } from "./surface.tsx";

const meta = preview.meta({
	title: "Patterns/DialogForm",
	component: DialogForm,
	tags: ["ai-generated"],
	args: { width: "compact" as const, onSubmit: fn(), children: <></> },
	render: (args) => (
		<Dialog>
			<DialogTrigger render={<Button variant="secondary" />}>Edit workspace</DialogTrigger>
			<DialogForm
				{...args}
				onSubmit={(event) => {
					event.preventDefault();
					args.onSubmit(event);
				}}
			>
				<SurfaceHeader>
					<SurfaceTitle
						title={<DialogTitle>Edit workspace</DialogTitle>}
						subtitle={
							<DialogDescription>Choose a name your team will recognise.</DialogDescription>
						}
					/>
				</SurfaceHeader>
				<DialogFormBody>
					<Field id="workspace-name" label="Workspace name">
						<Input id="workspace-name" defaultValue="Suga Workspace" required />
					</Field>
				</DialogFormBody>
				<DialogFormFooter>
					<DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
					<Button type="submit">Save changes</Button>
				</DialogFormFooter>
			</DialogForm>
		</Dialog>
	),
});

/** EditDetails composes the standard header, fields, and actions inside a modal. */
export const EditDetails = meta.story({
	play: async ({ canvas, canvasElement, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Edit workspace" }));
		const dialog = await within(canvasElement.ownerDocument.body).findByRole("dialog");
		await expect(within(dialog).getByRole("textbox", { name: "Workspace name" })).toBeVisible();
	},
});

/** KeyboardDismissal demonstrates that Escape returns focus to the opening control. */
export const KeyboardDismissal = meta.story({
	play: async ({ canvas, canvasElement, userEvent }) => {
		const trigger = canvas.getByRole("button", { name: "Edit workspace" });
		await userEvent.click(trigger);
		const body = within(canvasElement.ownerDocument.body);
		await body.findByRole("dialog");
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(trigger).toHaveFocus());
		await waitFor(() => expect(body.queryByRole("dialog")).not.toBeInTheDocument());
	},
});
