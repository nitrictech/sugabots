import { useState } from "react";
import { expect, fn, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { Button } from "./button.tsx";
import { Dialog, DialogDescription, DialogTrigger } from "./dialog.tsx";
import { DialogForm, DialogFormBody, DialogFormHeader } from "./dialog-form.tsx";
import { SettingsFieldRow, SettingsGroup } from "./settings-page.tsx";

function NewPodForm({ onSubmit }: { onSubmit: () => void }) {
	const [name, setName] = useState("");
	return (
		<Dialog>
			<DialogTrigger render={<Button variant="secondary" />}>New pod</DialogTrigger>
			<DialogForm
				width="compact"
				onSubmit={(event) => {
					event.preventDefault();
					onSubmit();
				}}
			>
				<DialogFormHeader title="New pod" action="Create" actionDisabled={name.trim() === ""} />
				<DialogFormBody>
					<DialogDescription>You'll add bots, people and connections next.</DialogDescription>
					<SettingsGroup>
						<SettingsFieldRow
							label="Name"
							value={name}
							onChange={setName}
							placeholder="Pod name, e.g. Support"
						/>
					</SettingsGroup>
				</DialogFormBody>
			</DialogForm>
		</Dialog>
	);
}

const meta = preview.meta({
	title: "Patterns/DialogForm",
	component: DialogForm,
	tags: ["ai-generated"],
	args: { width: "compact" as const, onSubmit: fn(), children: <></> },
	render: (args) => <NewPodForm onSubmit={() => args.onSubmit({} as never)} />,
});

/** CreateWhenValid shows the header action faded until the form can be submitted. */
export const CreateWhenValid = meta.story({
	play: async ({ args, canvas, canvasElement, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "New pod" }));
		const dialog = await within(canvasElement.ownerDocument.body).findByRole("dialog");
		const create = within(dialog).getByRole("button", { name: "Create" });
		await expect(create).toBeDisabled();
		await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "Support");
		await expect(create).toBeEnabled();
		await userEvent.click(create);
		await expect(args.onSubmit).toHaveBeenCalled();
	},
});

/** CancelCloses shows Cancel in the header dismissing the dialog and returning focus. */
export const CancelCloses = meta.story({
	play: async ({ canvas, canvasElement, userEvent }) => {
		const trigger = canvas.getByRole("button", { name: "New pod" });
		await userEvent.click(trigger);
		const body = within(canvasElement.ownerDocument.body);
		const dialog = await body.findByRole("dialog");
		await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(body.queryByRole("dialog")).not.toBeInTheDocument());
		await waitFor(() => expect(trigger).toHaveFocus());
	},
});

/** KeyboardDismissal demonstrates that Escape returns focus to the opening control. */
export const KeyboardDismissal = meta.story({
	play: async ({ canvas, canvasElement, userEvent }) => {
		const trigger = canvas.getByRole("button", { name: "New pod" });
		await userEvent.click(trigger);
		const body = within(canvasElement.ownerDocument.body);
		await body.findByRole("dialog");
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(trigger).toHaveFocus());
		await waitFor(() => expect(body.queryByRole("dialog")).not.toBeInTheDocument());
	},
});
