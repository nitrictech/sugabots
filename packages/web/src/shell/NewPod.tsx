import { slugify } from "@sugabots/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useCreatePod } from "@/lib/pods.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button, type ButtonProps } from "@/ui/button.tsx";
import { Dialog, DialogClose, DialogTitle } from "@/ui/dialog.tsx";
import { DialogForm, DialogFormBody, DialogFormFooter } from "@/ui/dialog-form.tsx";
import { Field } from "@/ui/field.tsx";
import { Input } from "@/ui/input.tsx";
import { SurfaceHeader, SurfaceTitle } from "@/ui/surface.tsx";

export function NewPodButton({
	variant,
	className,
}: Pick<ButtonProps, "variant" | "className"> = {}) {
	const [open, setOpen] = useState(false);
	const navigate = useNavigate();

	return (
		<>
			<Button type="button" variant={variant} className={className} onClick={() => setOpen(true)}>
				<Plus size={15} />
				New pod
			</Button>

			<Dialog open={open} onOpenChange={setOpen}>
				<NewPodDialog
					onCreated={async (podId) => {
						setOpen(false);
						await navigate({ to: "/settings/pods/$pod", params: { pod: podId } });
					}}
				/>
			</Dialog>
		</>
	);
}

function NewPodDialog({ onCreated }: { onCreated: (podId: string) => Promise<void> }) {
	const [name, setName] = useState("");
	const create = useCreatePod();
	const slug = slugify(name);

	async function submit(event: FormEvent) {
		event.preventDefault();
		try {
			const pod = await create.mutateAsync({ name });
			if (!pod) throw new Error("pod creation returned no pod");
			await onCreated(pod.id);
		} catch {
			return;
		}
	}

	return (
		<DialogForm width="compact" onSubmit={submit}>
			<SurfaceHeader>
				<SurfaceTitle
					title={<DialogTitle>New pod</DialogTitle>}
					subtitle="A folder of agents, and the people who can see into it"
				/>
			</SurfaceHeader>

			<DialogFormBody gap="compact">
				<Field id="pod-name" label="Name">
					<Input
						id="pod-name"
						value={name}
						onChange={(event) => setName(event.target.value)}
						placeholder="Suga-Team"
						required
					/>
					{/*
					 * Shown rather than asked for: it is derived from the name by the
					 * same function the API uses, and it turns up in every URL, so
					 * somebody naming a pod should see what they are committing
					 * to. Inside the field so it reads as part of it.
					 */}
					<p className="text-md text-muted-foreground">
						{slug === "" ? (
							"Its address is made from the name."
						) : (
							<>
								Its address will be <span className="font-mono text-foreground">{slug}</span>
							</>
						)}
					</p>
				</Field>

				{create.error && (
					<Alert>
						{failureMessage(create.error, {
							Conflict: "A pod with that address already exists. Try another name.",
							Forbidden: "Only a workspace admin can create a pod.",
						})}
					</Alert>
				)}
			</DialogFormBody>

			<DialogFormFooter>
				<DialogClose render={<Button type="button" variant="outline" size="sm" />}>
					Cancel
				</DialogClose>
				<Button type="submit" size="sm" disabled={slug === "" || create.isPending}>
					{create.isPending ? "Creating…" : "Create pod"}
				</Button>
			</DialogFormFooter>
		</DialogForm>
	);
}
