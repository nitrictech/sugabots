import { type Pod, slugify } from "@sugabots/contracts";
import { type FormEvent, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useCreatePod } from "@/lib/pods.ts";
import { PodTile } from "@/shell/PodTile.tsx";
import { Alert } from "@/ui/alert.tsx";
import { DialogForm, DialogFormBody, DialogFormHeader } from "@/ui/dialog-form.tsx";

/** Making a pod: a name, over the empty tile it starts as. Its bots, people and connections come after. */
export function NewPodDialog({ onCreated }: { onCreated: (pod: Pod) => Promise<void> }) {
	const [name, setName] = useState("");
	const create = useCreatePod();
	// The API makes the pod's address from its name, so a name with nothing to make one from is no name.
	const usable = slugify(name) !== "";

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!usable) return;
		try {
			const pod = await create.mutateAsync({ name });
			if (!pod) throw new Error("pod creation returned no pod");
			await onCreated(pod);
		} catch {
			return;
		}
	}

	return (
		<DialogForm width="compact" onSubmit={submit}>
			<DialogFormHeader
				title="New pod"
				action="Create"
				actionDisabled={!usable || create.isPending}
			/>

			<DialogFormBody gap="compact">
				<div className="flex justify-center pb-1">
					<PodTile bots={[]} size={72} />
				</div>
				<input
					aria-label="Name"
					value={name}
					onChange={(event) => setName(event.target.value)}
					placeholder="Pod name, e.g. Support"
					maxLength={64}
					className="focus-ring w-full rounded-2xl bg-list px-4 py-3.5 text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
				/>
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
		</DialogForm>
	);
}
