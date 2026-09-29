import type { Agent, AgentColor, AgentFace, Pod } from "@sugabots/contracts";
import { Check, ChevronRight } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useAgents, useCreateAgent, useModels } from "@/lib/agents.ts";
import { failureMessage } from "@/lib/failure.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { LookPicker } from "@/shell/LookPicker.tsx";
import { PodTile } from "@/shell/PodTile.tsx";
import { Alert } from "@/ui/alert.tsx";
import {
	DialogForm,
	DialogFormBody,
	DialogFormFooter,
	DialogFormHeader,
} from "@/ui/dialog-form.tsx";
import { SettingsFieldLabel, SettingsFieldRow, SettingsGroup } from "@/ui/settings-page.tsx";

/**
 * Making a bot: its face first, as it will look, then its name and the pod it
 * lives in. It runs on the workspace's first switched-on model until somebody
 * chooses another on its page, which is also where it is described.
 */
export function NewAgentDialog({
	podId: fixedPodId,
	pods = [],
	onCreated,
}: {
	/** The pod the bot is made in, when the dialog is opened from one. */
	podId?: string;
	/** The pods to choose from when it is not: those the viewer may add a bot to. */
	pods?: readonly Pod[];
	onCreated: (agent: Agent, pod: Pod | undefined) => Promise<void>;
}) {
	const [name, setName] = useState("");
	const [color, setColor] = useState<AgentColor>("green");
	const [face, setFace] = useState<AgentFace>("pill");
	const [chosenPodId, setChosenPodId] = useState(pods[0]?.id);
	const [choosingPod, setChoosingPod] = useState(false);
	const podId = fixedPodId ?? chosenPodId ?? "";
	const create = useCreateAgent(podId);
	const models = useModels();
	const offered = models.data?.models ?? [];
	// The default goes unoffered while a failed test has its provider off.
	const model =
		offered.find((candidate) => candidate.modelId === models.data?.defaultModel)?.modelId ??
		offered[0]?.modelId;
	const trimmedName = name.trim();
	const chosenPod = pods.find((pod) => pod.id === podId);

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!trimmedName || !model || !podId) return;
		try {
			const agent = await create.mutateAsync({ name: trimmedName, model, color, face });
			await onCreated(agent, chosenPod);
		} catch {
			return;
		}
	}

	return (
		<DialogForm onSubmit={submit}>
			<DialogFormHeader title="New bot" />

			<DialogFormBody gap="compact">
				<div className="flex justify-center pt-1 pb-2">
					<AgentAvatar color={color} face={face} size={88} />
				</div>
				<SettingsGroup>
					<LookPicker color={color} face={face} onColorChange={setColor} onFaceChange={setFace} />
				</SettingsGroup>

				<SettingsGroup className="mt-2">
					<SettingsFieldRow
						label="Name"
						value={name}
						onChange={setName}
						placeholder="e.g. Support Desk"
						maxLength={64}
					/>
					<PodRow
						fixed={fixedPodId !== undefined}
						pods={pods}
						chosen={chosenPod}
						open={choosingPod}
						onToggle={() => setChoosingPod(!choosingPod)}
						onChoose={(pod) => {
							setChosenPodId(pod.id);
							setChoosingPod(false);
						}}
					/>
				</SettingsGroup>

				<p className="m-0 px-1 text-[12.5px] text-subtle-foreground leading-normal">
					{models.isPending || model
						? "Every bot lives in one pod and uses that pod's connections. You can describe it and choose a model after it's created."
						: "Connect a model first, in Settings under Models. Bots think with one."}
				</p>

				{models.error && <Alert>Models could not be loaded. Close this form and try again.</Alert>}
				{create.error && (
					<Alert>
						{failureMessage(create.error, {
							Conflict: "A bot with that name already exists. Try another name.",
							Forbidden: "Only a workspace admin can create a bot.",
						})}
					</Alert>
				)}
			</DialogFormBody>
			<DialogFormFooter
				action="Create"
				actionDisabled={!trimmedName || !model || !podId || create.isPending}
			/>
		</DialogForm>
	);
}

/**
 * The pod the bot will live in: stated when the dialog was opened from one,
 * and otherwise a row that opens the pods to choose from beneath it.
 */
function PodRow({
	fixed,
	pods,
	chosen,
	open,
	onToggle,
	onChoose,
}: {
	fixed: boolean;
	pods: readonly Pod[];
	chosen: Pod | undefined;
	open: boolean;
	onToggle: () => void;
	onChoose: (pod: Pod) => void;
}) {
	const { agents } = useAgents();
	const botsIn = (pod: Pod) =>
		agents?.filter((agent) => agent.podId === pod.id && agent.systemAgentKey === null) ?? [];
	const label = <SettingsFieldLabel>Pod</SettingsFieldLabel>;

	if (fixed || pods.length <= 1) {
		return (
			<div className="flex min-h-[46px] items-center gap-3 px-4 py-2.5">
				{label}
				<span className="min-w-0 flex-1 truncate text-[14.5px] text-foreground">
					{chosen?.name ?? (fixed ? "This pod" : "No pod to add to")}
				</span>
			</div>
		);
	}
	return (
		<>
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={open}
				aria-label={`Pod: ${chosen?.name ?? "choose one"}`}
				className="focus-ring flex min-h-[46px] w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-panel"
			>
				{label}
				<span className="min-w-0 flex-1 truncate text-[14.5px] text-foreground">
					{chosen?.name ?? "Choose a pod"}
				</span>
				<ChevronRight
					aria-hidden
					size={14}
					strokeWidth={2.6}
					className={`shrink-0 text-subtle-foreground transition-transform ${open ? "rotate-90" : ""}`}
				/>
			</button>
			{open && (
				<ul aria-label="Pods" className="m-0 list-none border-border border-t p-0">
					{pods.map((pod) => (
						<li key={pod.id}>
							<button
								type="button"
								onClick={() => onChoose(pod)}
								aria-pressed={pod.id === chosen?.id}
								className="focus-ring flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-panel"
							>
								<PodTile bots={botsIn(pod)} color={pod.color} size={28} />
								<span className="min-w-0 flex-1 truncate text-[14.5px] text-foreground">
									{pod.name}
								</span>
								{pod.id === chosen?.id && (
									<Check aria-hidden size={15} strokeWidth={2.8} className="shrink-0 text-link" />
								)}
							</button>
						</li>
					))}
				</ul>
			)}
		</>
	);
}
