import { hueFromText } from "@sugabots/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useCreateAgent, useModels } from "@/lib/agents.ts";
import { failureMessage } from "@/lib/failure.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Alert } from "@/ui/alert.tsx";
import { Button, type ButtonProps } from "@/ui/button.tsx";
import { Dialog, DialogClose, DialogTitle } from "@/ui/dialog.tsx";
import { DialogForm, DialogFormBody, DialogFormFooter } from "@/ui/dialog-form.tsx";
import { Field } from "@/ui/field.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Input } from "@/ui/input.tsx";
import { ModelPicker } from "@/ui/model-picker.tsx";
import { SurfaceHeader, SurfaceTitle } from "@/ui/surface.tsx";

export function NewAgentButton({
	podId,
	iconOnly = false,
	variant,
	className,
}: Pick<ButtonProps, "variant" | "className"> & { podId: string; iconOnly?: boolean }) {
	const [open, setOpen] = useState(false);
	const navigate = useNavigate();

	return (
		<>
			{iconOnly ? (
				<IconButton label="New agent" size="lg" onClick={() => setOpen(true)}>
					<Plus />
				</IconButton>
			) : (
				<Button type="button" variant={variant} className={className} onClick={() => setOpen(true)}>
					<Plus size={15} />
					New agent
				</Button>
			)}

			<Dialog open={open} onOpenChange={setOpen}>
				<NewAgentDialog
					podId={podId}
					onCreated={async (agentId) => {
						setOpen(false);
						await navigate({
							to: "/settings/pods/$pod/agents/$agent",
							params: { pod: podId, agent: agentId },
						});
					}}
				/>
			</Dialog>
		</>
	);
}

/**
 * The form itself, for callers that bring their own trigger — the rail opens it
 * from a pod's heading, where a `Button` would not fit.
 */
export function NewAgentDialog({
	podId,
	onCreated,
}: {
	podId: string;
	onCreated: (agentId: string) => Promise<void>;
}) {
	const [name, setName] = useState("");
	const [selectedModel, setSelectedModel] = useState<string>();
	const create = useCreateAgent(podId);
	const models = useModels();
	const model = selectedModel ?? models.data?.models[0]?.modelId ?? "";
	const trimmedName = name.trim();

	async function submit(event: FormEvent) {
		event.preventDefault();
		try {
			const agent = await create.mutateAsync({ name: trimmedName, model });
			await onCreated(agent.id);
		} catch {
			return;
		}
	}

	return (
		<DialogForm onSubmit={submit}>
			<SurfaceHeader>
				<AgentAvatar hue={hueFromText(trimmedName)} face="bar" size={40} />
				<SurfaceTitle
					title={<DialogTitle>New agent</DialogTitle>}
					subtitle="A shared agent for this pod"
				/>
			</SurfaceHeader>

			<DialogFormBody>
				<Field id="agent-name" label="Name">
					<Input
						id="agent-name"
						value={name}
						onChange={(event) => setName(event.target.value)}
						placeholder="Release coordinator"
						maxLength={64}
						required
					/>
				</Field>

				<Field id="agent-model" label="Model">
					<ModelPicker
						id="agent-model"
						models={models.data?.models ?? []}
						value={model}
						onValueChange={setSelectedModel}
						disabled={models.isPending}
					/>
				</Field>

				{models.error && <Alert>Models could not be loaded. Close this form and try again.</Alert>}
				{create.error && (
					<Alert>
						{failureMessage(create.error, {
							Conflict: "An agent with that name already exists. Try another name.",
							Forbidden: "Only a workspace admin can create an agent.",
						})}
					</Alert>
				)}
			</DialogFormBody>

			<DialogFormFooter>
				<DialogClose render={<Button type="button" variant="outline" size="sm" />}>
					Cancel
				</DialogClose>
				<Button
					type="submit"
					size="sm"
					disabled={trimmedName === "" || model === "" || create.isPending}
				>
					{create.isPending ? "Creating…" : "Create agent"}
				</Button>
			</DialogFormFooter>
		</DialogForm>
	);
}
