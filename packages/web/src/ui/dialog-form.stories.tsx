import { useState } from "react";
import { expect, fn, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { Button } from "./button.tsx";
import { Dialog, DialogDescription, DialogTrigger } from "./dialog.tsx";
import {
	DialogForm,
	DialogFormBody,
	DialogFormFooter,
	DialogFormHeader,
	DialogFormScroll,
} from "./dialog-form.tsx";
import { SettingsFieldRow, SettingsGroup, SettingsRow } from "./settings-page.tsx";

function NewProjectForm({ onSubmit }: { onSubmit: () => void }) {
	const [name, setName] = useState("");
	return (
		<Dialog>
			<DialogTrigger render={<Button variant="secondary" />}>New project</DialogTrigger>
			<DialogForm
				width="compact"
				onSubmit={(event) => {
					event.preventDefault();
					onSubmit();
				}}
			>
				<DialogFormHeader title="New project" />
				<DialogFormBody>
					<DialogDescription>You'll add bots, members and connectors next.</DialogDescription>
					<SettingsGroup>
						<SettingsFieldRow
							label="Name"
							value={name}
							onChange={setName}
							placeholder="Project name, e.g. Support"
						/>
					</SettingsGroup>
				</DialogFormBody>
				<DialogFormFooter action="Create" actionDisabled={name.trim() === ""} />
			</DialogForm>
		</Dialog>
	);
}

const meta = preview.meta({
	title: "Patterns/DialogForm",
	component: DialogForm,
	tags: ["ai-generated"],
	args: { width: "compact" as const, onSubmit: fn(), children: <></> },
	render: (args) => <NewProjectForm onSubmit={() => args.onSubmit({} as never)} />,
});

/** CreateWhenValid shows the footer action disabled until the form can be submitted. */
export const CreateWhenValid = meta.story({
	play: async ({ args, canvas, canvasElement, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "New project" }));
		const dialog = await within(canvasElement.ownerDocument.body).findByRole("dialog");
		const create = within(dialog).getByRole("button", { name: "Create" });
		await expect(create).toBeDisabled();
		await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "Support");
		await expect(create).toBeEnabled();
		await userEvent.click(create);
		await expect(args.onSubmit).toHaveBeenCalled();
	},
});

/** CancelCloses shows Cancel in the footer dismissing the dialog and returning focus. */
export const CancelCloses = meta.story({
	play: async ({ canvas, canvasElement, userEvent }) => {
		const trigger = canvas.getByRole("button", { name: "New project" });
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
		const trigger = canvas.getByRole("button", { name: "New project" });
		await userEvent.click(trigger);
		const body = within(canvasElement.ownerDocument.body);
		await body.findByRole("dialog");
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(trigger).toHaveFocus());
		await waitFor(() => expect(body.queryByRole("dialog")).not.toBeInTheDocument());
	},
});

const apps = Array.from({ length: 30 }, (_, index) => `App ${index + 1}`);

/** A long list scrolls inside the dialog, under the header that stays put. */
export const LongList = meta.story({
	render: () => (
		<Dialog open>
			<DialogForm width="compact" onSubmit={(event) => event.preventDefault()}>
				<DialogFormHeader title="Add an app" />
				<DialogFormBody>
					<DialogFormScroll height="picker">
						<SettingsGroup label="Apps">
							{apps.map((app) => (
								<SettingsRow key={app} label={app} onClick={fn()} />
							))}
						</SettingsGroup>
					</DialogFormScroll>
				</DialogFormBody>
			</DialogForm>
		</Dialog>
	),
	play: async ({ canvasElement }) => {
		const dialog = await within(canvasElement.ownerDocument.body).findByRole("dialog");
		const list = within(dialog).getByText("App 1").closest<HTMLElement>(".overflow-y-auto");
		await expect(list?.scrollHeight).toBeGreaterThan(list?.clientHeight ?? 0);
	},
});
