import { type FormEvent, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useSaving } from "@/lib/saving.ts";
import { Alert } from "@/ui/alert.tsx";
import {
	DialogForm,
	DialogFormBody,
	DialogFormFooter,
	DialogFormHeader,
} from "@/ui/dialog-form.tsx";
import { SettingsFieldRow, SettingsGroup } from "@/ui/settings-page.tsx";

/**
 * Renaming something, under `title`, starting from its `name`. Save is off
 * until the name is changed and not blank. `onSave` is given the name
 * trimmed; while it fails, the dialog stays open and says why.
 */
export function NameDialog({
	title,
	name: savedName,
	maxLength,
	placeholder,
	onSave,
}: {
	title: string;
	name: string;
	maxLength: number;
	/** An example name, such as "e.g. Pricing". */
	placeholder: string;
	onSave: (name: string) => Promise<unknown>;
}) {
	const [name, setName] = useState(savedName);
	const next = name.trim();
	const { pending, failure, save } = useSaving();
	function submit(event: FormEvent) {
		event.preventDefault();
		void save(() => onSave(next));
	}
	return (
		<DialogForm onSubmit={submit}>
			<DialogFormHeader title={title} />
			<DialogFormBody gap="compact">
				<SettingsGroup>
					<SettingsFieldRow
						label="Name"
						value={name}
						onChange={setName}
						placeholder={placeholder}
						maxLength={maxLength}
					/>
				</SettingsGroup>
				{failure !== undefined && <Alert>{failureMessage(failure)}</Alert>}
			</DialogFormBody>
			<DialogFormFooter
				action="Save"
				actionDisabled={pending || next === "" || next === savedName}
			/>
		</DialogForm>
	);
}
