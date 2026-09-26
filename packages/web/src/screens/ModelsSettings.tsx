import {
	type ModelProvider,
	type ProviderPreset,
	type ProviderPresetId,
	providerCatalog,
} from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check, Code } from "lucide-react";
import { type FormEvent, useState } from "react";
import {
	BUILT_IN_AGENT_KEYS,
	useBuiltInAgents,
	useChooseBuiltInAgentModel,
} from "@/lib/built-in-agents.ts";
import { failureMessage } from "@/lib/failure.ts";
import { useModelProviders, useProviderActions } from "@/lib/model-providers.ts";
import { parseProviderBaseUrl } from "@/lib/provider-url.ts";
import { useWorkspacePermissions } from "@/lib/workspace.ts";
import { Alert } from "@/ui/alert.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import {
	DialogFormBody,
	DialogFormFrame,
	DialogFormHeader,
	DialogFormStep,
} from "@/ui/dialog-form.tsx";
import { SegmentedControl } from "@/ui/segmented-control.tsx";
import {
	SettingsAddRow,
	SettingsFieldRow,
	SettingsGroup,
	SettingsPage,
	SettingsRow,
	SettingsRowIcon,
	SettingsValue,
} from "@/ui/settings-page.tsx";
import {
	API_FORMATS,
	BackToModels,
	BotFaces,
	isConnected,
	modelName,
	ProviderTile,
	useBotsByModel,
} from "./ProviderSettings.tsx";

/**
 * What bots think with: the model the system bots use, then each connected
 * provider with how many of its models are switched on, and adding another.
 */
export function ModelsSettings() {
	const providers = useModelProviders();
	const may = useWorkspacePermissions();
	const botsOn = useBotsByModel();
	const [adding, setAdding] = useState(false);
	const navigate = useNavigate();
	const listed = (providers.data ?? []).filter(
		(provider) => isConnected(provider) || provider.preset === null,
	);

	return (
		<SettingsPage
			title="Models"
			description="What your bots think with. Connect a provider, then pick which of its models bots can use."
		>
			{may.configureBuiltInAgents && (
				<SettingsGroup label="Default">
					<SystemModelRow providers={providers.data ?? []} />
				</SettingsGroup>
			)}
			<SettingsGroup label="Providers">
				{providers.error && (
					<div className="px-4 py-3">
						<Alert>{failureMessage(providers.error)}</Alert>
					</div>
				)}
				{listed.map((provider) => {
					const bots = provider.models
						.filter((model) => model.enabled)
						.flatMap((model) => botsOn(model.modelId));
					return (
						<SettingsRow
							key={provider.id}
							icon={<ProviderTile name={provider.name} preset={provider.preset} />}
							label={provider.name}
							sub={
								provider.active
									? `${provider.enabledModelCount} of ${provider.modelCount} models on`
									: "Turned off"
							}
							trailing={<BotFaces bots={bots} />}
							chevron
							render={
								<Link
									from="/$workspace"
									to="./settings/providers/$provider"
									params={{ provider: provider.id }}
								/>
							}
						/>
					);
				})}
				<SettingsAddRow label="Add provider" onClick={() => setAdding(true)} />
			</SettingsGroup>
			<Dialog open={adding} onOpenChange={setAdding}>
				{adding && (
					<AddProviderDialog
						providers={providers.data ?? []}
						done={() => setAdding(false)}
						onAdded={async (provider) => {
							setAdding(false);
							await navigate({
								from: "/$workspace",
								to: "./settings/providers/$provider",
								params: { provider: provider.id },
							});
						}}
					/>
				)}
			</Dialog>
		</SettingsPage>
	);
}

/** The Scribe's model stands for the system bots', since choosing one sets them all. */
function SystemModelRow({ providers }: { providers: readonly ModelProvider[] }) {
	const systemAgents = useBuiltInAgents();
	const current = systemAgents.data?.find((agent) => agent.key === "summarise")?.model ?? null;
	const model = providers
		.flatMap((provider) => provider.models)
		.find((candidate) => candidate.modelId === current);
	return (
		<SettingsRow
			label="System agents use"
			trailing={
				<SettingsValue>
					{current === null ? "Not set" : model ? modelName(model) : current}
				</SettingsValue>
			}
			chevron
			render={<Link from="/$workspace" to="./settings/providers/system" />}
		/>
	);
}

/**
 * One model for everything Sugabots does behind the scenes: thread summaries,
 * chat titles and handing a pod's floor to the right bot. Choosing it sets it
 * for every system bot at once.
 */
export function SystemModelSettings() {
	const providers = useModelProviders();
	const systemAgents = useBuiltInAgents();
	const summarise = useChooseBuiltInAgentModel("summarise");
	const facilitate = useChooseBuiltInAgentModel("facilitate");
	const choosers = { summarise, facilitate };
	const [error, setError] = useState<unknown>();
	const current = systemAgents.data?.find((agent) => agent.key === "summarise")?.model ?? null;
	const pending = summarise.isPending || facilitate.isPending;
	const groups = (providers.data ?? [])
		.filter((provider) => isConnected(provider))
		.map((provider) => ({
			provider,
			models: provider.models.filter((model) => model.enabled),
		}))
		.filter((group) => group.models.length > 0);

	async function choose(modelId: string) {
		setError(undefined);
		try {
			await Promise.all(BUILT_IN_AGENT_KEYS.map((key) => choosers[key].mutateAsync(modelId)));
		} catch (cause) {
			setError(cause);
		}
	}

	return (
		<SettingsPage
			back={<BackToModels />}
			title="System agents"
			description="The model Sugabots uses behind the scenes: summaries, chat titles and routing collaborations. A fast, cheap model works best."
		>
			{error !== undefined && <Alert>{failureMessage(error)}</Alert>}
			{groups.length === 0 && !providers.isPending && (
				<SettingsGroup>
					<SettingsRow label="No models are switched on yet." />
				</SettingsGroup>
			)}
			{groups.map(({ provider, models }) => (
				<SettingsGroup key={provider.id} label={provider.name}>
					{models.map((model) => {
						const chosen = model.modelId === current;
						return (
							<SettingsRow
								key={model.id}
								label={modelName(model)}
								trailing={
									chosen && (
										<Check aria-hidden size={16} strokeWidth={2.6} className="shrink-0 text-link" />
									)
								}
								onClick={pending || chosen ? undefined : () => void choose(model.modelId)}
								className={chosen ? "cursor-default" : undefined}
							/>
						);
					})}
				</SettingsGroup>
			))}
			<p className="-mt-3 m-0 px-1 text-sm text-subtle-foreground">
				Only models that are switched on appear here.
			</p>
		</SettingsPage>
	);
}

type Choice = { preset: ProviderPreset; existing?: ModelProvider } | "custom";

/**
 * Adding a provider, in two steps inside one dialog: which one, then what it
 * needs. The three every workspace starts with already exist, so adding one
 * of them gives the existing record its key rather than making another.
 */
export function AddProviderDialog(props: {
	providers: readonly ModelProvider[];
	done: () => void;
	onAdded: (provider: ModelProvider) => Promise<void>;
}) {
	return (
		<DialogFormFrame>
			<AddProviderSteps {...props} />
		</DialogFormFrame>
	);
}

function AddProviderSteps({
	providers,
	done,
	onAdded,
}: {
	providers: readonly ModelProvider[];
	done: () => void;
	onAdded: (provider: ModelProvider) => Promise<void>;
}) {
	const [choice, setChoice] = useState<Choice>();
	const byPreset = new Map(
		providers
			.filter((provider) => provider.preset !== null)
			.map((provider) => [provider.preset as ProviderPresetId, provider]),
	);
	const available = providerCatalog.filter((preset) => {
		const existing = byPreset.get(preset.id);
		return !existing || !isConnected(existing);
	});

	if (choice === "custom") {
		return <CustomProviderStep onBack={() => setChoice(undefined)} onAdded={onAdded} />;
	}
	if (choice) {
		return (
			<PresetStep
				preset={choice.preset}
				existing={choice.existing}
				onBack={() => setChoice(undefined)}
				onAdded={onAdded}
			/>
		);
	}

	const groups = [
		{ label: "Popular", presets: available.filter((preset) => preset.hosting === "remote") },
		{
			label: "On your own machine",
			presets: available.filter((preset) => preset.hosting === "local"),
		},
	].filter((group) => group.presets.length > 0);

	return (
		<DialogFormStep onSubmit={(event) => event.preventDefault()}>
			<DialogFormHeader title="Add provider" onCancel={done} />
			<DialogFormBody>
				{/* The catalog runs longer than a short window, so the list scrolls inside the dialog. */}
				<div className="-mx-1 flex max-h-[min(560px,65vh)] flex-col gap-5 overflow-y-auto px-1">
					{groups.map((group) => (
						<SettingsGroup key={group.label} label={group.label}>
							{group.presets.map((preset) => (
								<SettingsRow
									key={preset.id}
									icon={<ProviderTile name={preset.name} preset={preset.id} />}
									label={preset.name}
									sub={firstSentence(preset.hint)}
									chevron
									onClick={() => setChoice({ preset, existing: byPreset.get(preset.id) })}
								/>
							))}
						</SettingsGroup>
					))}
					<SettingsGroup label="Something else">
						<SettingsRow
							icon={
								<SettingsRowIcon>
									<Code size={15} strokeWidth={2.2} />
								</SettingsRowIcon>
							}
							label="Custom provider"
							sub="Any service using the OpenAI or Anthropic format"
							chevron
							onClick={() => setChoice("custom")}
						/>
					</SettingsGroup>
				</div>
			</DialogFormBody>
		</DialogFormStep>
	);
}

function PresetStep({
	preset,
	existing,
	onBack,
	onAdded,
}: {
	preset: ProviderPreset;
	existing?: ModelProvider;
	onBack: () => void;
	onAdded: (provider: ModelProvider) => Promise<void>;
}) {
	const actions = useProviderActions();
	const [apiKey, setApiKey] = useState("");
	const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? preset.baseUrl);
	const [error, setError] = useState<unknown>();
	const local = preset.hosting === "local";
	const typedBaseUrl = parseProviderBaseUrl(baseUrl);
	const ready = (!preset.requiresApiKey || apiKey !== "") && (!local || typedBaseUrl !== undefined);
	const pending = actions.create.isPending || actions.update.isPending;

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!ready) return;
		setError(undefined);
		try {
			const added = existing
				? await actions.update.mutateAsync({
						providerId: existing.id,
						json: {
							active: true,
							...(apiKey ? { apiKey } : {}),
							...(local && typedBaseUrl !== existing.baseUrl ? { baseUrl: typedBaseUrl } : {}),
						},
					})
				: await actions.create.mutateAsync({
						preset: preset.id,
						apiKey: apiKey || undefined,
						...(local && typedBaseUrl !== preset.baseUrl ? { baseUrl: typedBaseUrl } : {}),
					});
			if (!added) throw new Error("The provider could not be loaded");
			await onAdded(added);
		} catch (cause) {
			setError(cause);
		}
	}

	return (
		<DialogFormStep onSubmit={submit}>
			<DialogFormHeader
				title={preset.name}
				action="Add"
				actionDisabled={!ready || pending}
				cancelDisabled={pending}
				onBack={onBack}
			/>
			<DialogFormBody>
				<SettingsGroup note={preset.hint}>
					{local && (
						<SettingsFieldRow
							label="Server URL"
							value={baseUrl}
							onChange={setBaseUrl}
							placeholder={preset.baseUrl}
							mono
						/>
					)}
					<SettingsFieldRow
						label="API key"
						value={apiKey}
						onChange={setApiKey}
						placeholder={preset.requiresApiKey ? "Paste your key" : "Optional"}
						mono
						secret
					/>
				</SettingsGroup>
				{local && baseUrl.trim() !== "" && typedBaseUrl === undefined && (
					<Alert>
						That is not a server address. A host and port, like 192.168.1.10:11434, is enough.
					</Alert>
				)}
				{error !== undefined && <Alert>{failureMessage(error)}</Alert>}
			</DialogFormBody>
		</DialogFormStep>
	);
}

function CustomProviderStep({
	onBack,
	onAdded,
}: {
	onBack: () => void;
	onAdded: (provider: ModelProvider) => Promise<void>;
}) {
	const actions = useProviderActions();
	const [name, setName] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [apiFormat, setApiFormat] = useState<"openai" | "anthropic">("openai");
	const [apiKey, setApiKey] = useState("");
	const [error, setError] = useState<unknown>();
	const typedBaseUrl = parseProviderBaseUrl(baseUrl);
	const ready = name.trim() !== "" && typedBaseUrl !== undefined;

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!ready || typedBaseUrl === undefined) return;
		setError(undefined);
		try {
			const added = await actions.create.mutateAsync({
				name: name.trim(),
				baseUrl: typedBaseUrl,
				apiFormat,
				apiKey: apiKey || undefined,
				customHeaders: [],
			});
			if (!added) throw new Error("The provider could not be loaded");
			await onAdded(added);
		} catch (cause) {
			setError(cause);
		}
	}

	return (
		<DialogFormStep onSubmit={submit}>
			<DialogFormHeader
				title="Custom provider"
				action="Add"
				actionDisabled={!ready || actions.create.isPending}
				cancelDisabled={actions.create.isPending}
				onBack={onBack}
			/>
			<DialogFormBody>
				<SettingsGroup>
					<SettingsFieldRow
						label="Name"
						value={name}
						onChange={setName}
						placeholder="e.g. Company gateway"
					/>
					<SettingsFieldRow
						label="Address"
						value={baseUrl}
						onChange={setBaseUrl}
						placeholder="https://llm.example.com/v1"
						mono
					/>
					<div className="flex min-h-[46px] items-center gap-3 border-border border-b px-4 py-2.5">
						<span className="flex-1 text-[14px] text-foreground">Format</span>
						<SegmentedControl
							label="API format"
							options={API_FORMATS}
							value={apiFormat}
							onChange={setApiFormat}
						/>
					</div>
					<SettingsFieldRow
						label="API key"
						value={apiKey}
						onChange={setApiKey}
						placeholder="Optional"
						mono
						secret
					/>
				</SettingsGroup>
				{error !== undefined && <Alert>{failureMessage(error)}</Alert>}
			</DialogFormBody>
		</DialogFormStep>
	);
}

/** A preset's hint is a line or two; the picker has room for what comes before the first stop. */
function firstSentence(text: string): string {
	const stop = text.indexOf(". ");
	return stop === -1 ? text.replace(/\.$/, "") : text.slice(0, stop);
}
