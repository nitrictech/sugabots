import { CHAT_NAME_MAX_LENGTH } from "@sugabots/contracts";
import { type FormEvent, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { Alert } from "@/ui/alert.tsx";
import {
	DialogForm,
	DialogFormBody,
	DialogFormFooter,
	DialogFormHeader,
} from "@/ui/dialog-form.tsx";
import { SettingsFieldRow, SettingsGroup } from "@/ui/settings-page.tsx";

/**
 * Naming a chat in a pod: a new one, under `title` "New channel", or one being
 * renamed, starting from its `name`. `onSave` is given the name as written.
 */
export function ChatNameDialog({
	title,
	name: initialName = "",
	action,
	onSave,
}: {
	title: string;
	name?: string;
	action: string;
	onSave: (name: string) => Promise<unknown>;
}) {
	const [name, setName] = useState(initialName);
	const [saving, setSaving] = useState(false);
	const [failure, setFailure] = useState<unknown>();
	const usable = name.trim() !== "";

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!usable || saving) return;
		setSaving(true);
		setFailure(undefined);
		try {
			await onSave(name.trim());
		} catch (error) {
			setFailure(error);
		} finally {
			setSaving(false);
		}
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
						placeholder="e.g. Pricing"
						maxLength={CHAT_NAME_MAX_LENGTH}
					/>
				</SettingsGroup>
				<p className="m-0 px-1 text-[12.5px] text-subtle-foreground leading-normal">
					Everyone in the pod can read and write in it.
				</p>
				{failure !== undefined && (
					<Alert>
						{failureMessage(failure, { Forbidden: "Only someone who runs this pod can do that." })}
					</Alert>
				)}
			</DialogFormBody>
			<DialogFormFooter action={action} actionDisabled={!usable || saving} />
		</DialogForm>
	);
}
