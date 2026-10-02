import {
	leastUsedPodColor,
	POD_NAME_MAX_LENGTH,
	type Pod,
	type PodColor,
	slugify,
} from "@sugabots/contracts";
import { type FormEvent, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useCreatePod, usePods } from "@/lib/pods.ts";
import { PodColourPicker } from "@/shell/LookPicker.tsx";
import { PodTile } from "@/shell/PodTile.tsx";
import { Alert } from "@/ui/alert.tsx";
import {
	DialogForm,
	DialogFormBody,
	DialogFormFooter,
	DialogFormHeader,
} from "@/ui/dialog-form.tsx";
import { SettingsControlRow, SettingsFieldRow, SettingsGroup } from "@/ui/settings-page.tsx";

/**
 * Making a pod: a colour and a name, under the empty tile it starts as, laid
 * out as New bot is. Its bots, people and connections come after.
 */
export function NewPodDialog({ onCreated }: { onCreated: (pod: Pod) => Promise<void> }) {
	const [name, setName] = useState("");
	const { data: pods } = usePods();
	const [chosenColor, setChosenColor] = useState<PodColor>();
	// Until somebody picks one, the colour the workspace's pods have least of,
	// so pods made without a second thought still look unlike each other.
	const color = chosenColor ?? leastUsedPodColor(pods?.map((pod) => pod.color) ?? []);
	const create = useCreatePod();
	// The API makes the pod's address from its name, so a name with nothing to make one from is no name.
	const usable = slugify(name) !== "";

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!usable) return;
		try {
			const pod = await create.mutateAsync({ name, color });
			if (!pod) throw new Error("pod creation returned no pod");
			await onCreated(pod);
		} catch {
			return;
		}
	}

	return (
		<DialogForm onSubmit={submit}>
			<DialogFormHeader title="New pod" />

			<DialogFormBody gap="compact">
				<div className="flex justify-center pt-1 pb-2">
					<PodTile bots={[]} color={color} size={88} />
				</div>
				<SettingsGroup>
					<SettingsControlRow label="Colour">
						<PodColourPicker value={color} onChange={setChosenColor} />
					</SettingsControlRow>
				</SettingsGroup>

				<SettingsGroup className="mt-2">
					<SettingsFieldRow
						label="Name"
						value={name}
						onChange={setName}
						placeholder="e.g. Support"
						maxLength={POD_NAME_MAX_LENGTH}
					/>
				</SettingsGroup>
				<p className="m-0 px-1 text-[12.5px] text-subtle-foreground leading-normal">
					You'll add bots, people and connections next.
				</p>

				{create.error && (
					<Alert>
						{failureMessage(create.error, {
							Conflict: "A pod with that name already exists. Try another name.",
							Forbidden: "Only a workspace admin can create a pod.",
						})}
					</Alert>
				)}
			</DialogFormBody>
			<DialogFormFooter action="Create" actionDisabled={!usable || create.isPending} />
		</DialogForm>
	);
}
