import {
	type A2ACard,
	type A2AEndpointInput,
	type Agent,
	type AgentColor,
	type AgentFace,
	type AgentShape,
	type Pod,
	PROMPT_MAX_LENGTH,
} from "@sugabots/contracts";
import { Check, ChevronRight } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { useAgents, useCreateAgent, useModels, useReadA2ACard } from "@/lib/agents.ts";
import { useThisDevice } from "@/lib/devices.ts";
import { failureMessage } from "@/lib/failure.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { LookPicker } from "@/shell/LookPicker.tsx";
import { PodTile } from "@/shell/PodTile.tsx";
import {
	type A2ADraft,
	A2AEndpointFields,
	type A2APlace,
	A2APlaceControl,
	A2ASecretFields,
	a2aEndpointOf,
	type DeviceAgentChoice,
	DeviceAgentPicker,
	emptyA2ADraft,
	type RunsOn,
	RunsOnControl,
} from "@/shell/RunsOn.tsx";
import { Alert, Success } from "@/ui/alert.tsx";
import {
	DialogForm,
	DialogFormBody,
	DialogFormFooter,
	DialogFormHeader,
} from "@/ui/dialog-form.tsx";
import { SegmentedControl } from "@/ui/segmented-control.tsx";
import {
	SettingsControlRow,
	SettingsFieldLabel,
	SettingsFieldRow,
	SettingsGroup,
} from "@/ui/settings-page.tsx";

/** How the bot gets its first instructions: it interviews its creator, or they write them. */
type InstructionsStart = "interview" | "written";

const INSTRUCTIONS_STARTS = [
	{ value: "interview", label: "Interview me" },
	{ value: "written", label: "Write my own" },
] as const satisfies readonly { value: InstructionsStart; label: string }[];

/**
 * Making a bot: its face first, as it will look, then its name and the pod it
 * lives in, then what it runs on. On a model, the workspace's first switched-on
 * one until somebody chooses another on its page, it interviews its creator for
 * its instructions or is given them. On an external agent, its A2A card is read
 * once its address is typed, which shows the address works and names and
 * describes the bot after the agent, unless somebody has named it already. An
 * agent on one of the creator's computers is chosen from those it lends, whose
 * cards the desktop app has already read.
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
	const [shape, setShape] = useState<AgentShape>("circle");
	const [face, setFace] = useState<AgentFace>("pill");
	const [chosenPodId, setChosenPodId] = useState(pods[0]?.id);
	const [choosingPod, setChoosingPod] = useState(false);
	const [instructionsStart, setInstructionsStart] = useState<InstructionsStart>("interview");
	const [instructions, setInstructions] = useState("");
	const instructionsId = useId();
	const podId = fixedPodId ?? chosenPodId ?? "";
	const create = useCreateAgent(podId);
	const models = useModels();
	const offered = models.data?.models ?? [];
	const [chosenRunsOn, setChosenRunsOn] = useState<RunsOn>();
	// With no model to run on, an external agent is the only thing a bot can be.
	const runsOn = chosenRunsOn ?? (models.isSuccess && offered.length === 0 ? "a2a" : "model");
	const [chosenPlace, setPlace] = useState<A2APlace>("address");
	// Only the desktop app can lend this computer's agents, so a browser has only addresses.
	const thisDevice = useThisDevice();
	const place = thisDevice ? chosenPlace : "address";
	const [addressDraft, setAddressDraft] = useState<A2ADraft>(emptyA2ADraft);
	const [deviceDraft, setDeviceDraft] = useState<A2ADraft>(emptyA2ADraft);
	const [deviceAgent, setDeviceAgent] = useState<DeviceAgentChoice>();
	const a2aDraft = place === "address" ? addressDraft : deviceDraft;
	const endpoint = a2aEndpointOf(a2aDraft);
	const card = useAgentCard(podId, place === "address" ? endpoint : undefined);
	const found = place === "address" ? card.found : deviceAgent?.agent;
	// The default goes unoffered while a failed test has its provider off.
	const model =
		offered.find((candidate) => candidate.modelId === models.data?.defaultModel)?.modelId ??
		offered[0]?.modelId;
	const trimmedName = name.trim();
	const chosenPod = pods.find((pod) => pod.id === podId);

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!trimmedName || !podId) return;
		const look = { name: trimmedName, color, shape, face };
		if (runsOn === "a2a" ? !endpoint : !model) return;
		try {
			const agent = await create.mutateAsync(
				runsOn === "a2a"
					? {
							...look,
							a2a: endpoint,
							...(found?.description ? { description: found.description } : {}),
						}
					: {
							...look,
							model,
							// A bot created without a prompt starts by interviewing its creator.
							...(instructionsStart === "written" ? { prompt: instructions } : {}),
						},
			);
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
					<AgentAvatar color={color} face={face} shape={shape} size={88} />
				</div>
				<SettingsGroup>
					<LookPicker
						color={color}
						shape={shape}
						face={face}
						onColorChange={setColor}
						onShapeChange={setShape}
						onFaceChange={setFace}
					/>
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

				<SettingsGroup className="mt-2">
					<RunsOnControl value={runsOn} onChange={setChosenRunsOn} />
				</SettingsGroup>

				{runsOn === "a2a" && thisDevice && (
					<SettingsGroup className="mt-2">
						<A2APlaceControl value={place} onChange={setPlace} />
					</SettingsGroup>
				)}

				{runsOn === "a2a" && place === "device" ? (
					<>
						<DeviceAgentPicker
							chosen={
								deviceDraft.deviceId
									? { deviceId: deviceDraft.deviceId, url: deviceDraft.url }
									: undefined
							}
							onChoose={(choice) => {
								setDeviceAgent(choice);
								setDeviceDraft({
									...deviceDraft,
									url: choice.agent.url,
									deviceId: choice.deviceId,
								});
								// A name somebody typed stays; one taken from an earlier choice follows the new one.
								if (trimmedName === "" || trimmedName === card.named) {
									setName(choice.agent.name);
									card.setNamed(choice.agent.name);
								}
							}}
						/>
						{deviceAgent && <A2ASecretFields draft={deviceDraft} onChange={setDeviceDraft} />}
					</>
				) : runsOn === "a2a" ? (
					<>
						<A2AEndpointFields
							draft={addressDraft}
							onChange={setAddressDraft}
							onLeave={() => {
								void card.lookUp().then((found) => {
									// A name somebody typed stays; one taken from an earlier card follows the new one.
									if (found && (trimmedName === "" || trimmedName === card.named)) {
										setName(found.name);
										card.setNamed(found.name);
									}
								});
							}}
						/>
						{card.found && (
							<Success>
								Found {card.found.name}
								{card.found.description ? `: ${card.found.description}` : ""}
							</Success>
						)}
						{card.failure && <Alert>{card.failure}</Alert>}
					</>
				) : (
					<SettingsGroup
						className="mt-2"
						note={
							instructionsStart === "interview"
								? `${trimmedName || "It"} will ask what it's for in its first chat, then write its own instructions for you to approve.`
								: "Leave them blank to start without any. You can change them later in its settings."
						}
					>
						<SettingsControlRow label="Instructions">
							<SegmentedControl
								label="Instructions"
								options={INSTRUCTIONS_STARTS}
								value={instructionsStart}
								onChange={setInstructionsStart}
							/>
						</SettingsControlRow>
						{instructionsStart === "written" && (
							<div className="border-border border-t p-1">
								<label htmlFor={instructionsId} className="sr-only">
									Instructions
								</label>
								<textarea
									id={instructionsId}
									value={instructions}
									onChange={(event) => setInstructions(event.target.value)}
									maxLength={PROMPT_MAX_LENGTH}
									placeholder="What it's for, how to sound, and what to never do."
									className="block min-h-[120px] w-full resize-y rounded-[12px] bg-transparent p-3 text-[14.5px] text-foreground leading-[1.6] outline-none placeholder:text-subtle-foreground focus-visible:shadow-(--ring-shadow)"
								/>
							</div>
						)}
					</SettingsGroup>
				)}

				<p className="m-0 px-1 text-[12.5px] text-subtle-foreground leading-normal">
					{runsOn === "a2a"
						? "Every bot lives in one pod. This one answers with the external agent's own model, instructions and tools."
						: models.isPending || model
							? "Every bot lives in one pod and uses that pod's connections. You can describe it and choose a model after it's created."
							: "Connect a model first, in Settings under Models, or run it on an external agent."}
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
				actionDisabled={
					!trimmedName || !podId || create.isPending || (runsOn === "a2a" ? !endpoint : !model)
				}
			/>
		</DialogForm>
	);
}

/**
 * The card of the A2A agent at `endpoint`, read when asked. What was found, or
 * why nothing was, is shown only while the address and secret are still the
 * ones it was read with. `named` is the name last taken from a card, so a
 * later card can replace it where it would not replace a name somebody typed.
 */
function useAgentCard(podId: string, endpoint: A2AEndpointInput | undefined) {
	const read = useReadA2ACard(podId);
	const [result, setResult] = useState<
		{ key: string } & ({ found: A2ACard } | { failure: string })
	>();
	const [named, setNamed] = useState<string>();
	const key = endpoint && JSON.stringify(endpoint);
	const current = result && result.key === key ? result : undefined;

	async function lookUp(): Promise<A2ACard | undefined> {
		if (!endpoint || !key || !podId || current) return undefined;
		try {
			const found = await read.mutateAsync(endpoint);
			setResult({ key, found });
			return found;
		} catch (error) {
			setResult({ key, failure: failureMessage(error) });
			return undefined;
		}
	}

	return {
		lookUp,
		found: current && "found" in current ? current.found : undefined,
		failure: current && "failure" in current ? current.failure : undefined,
		named,
		setNamed,
	};
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
