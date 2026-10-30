import {
	effectiveCapabilities,
	type ModelProvider,
	type ProviderPreset,
	type ProviderPresetId,
	presetSignsIn,
	providerCatalog,
	providerLacksCredential,
	providerPreset,
	signInServiceNames,
} from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check, Code } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useModels } from "@/lib/agents.ts";
import {
	BUILT_IN_AGENT_KEYS,
	useBuiltInAgents,
	useChooseBuiltInAgentModel,
} from "@/lib/built-in-agents.ts";
import { failureMessage } from "@/lib/failure.ts";
import {
	useChooseDefaultModel,
	useModelProviders,
	useProviderActions,
} from "@/lib/model-providers.ts";
import { parseProviderBaseUrl } from "@/lib/provider-url.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { useWorkspacePermissions } from "@/lib/workspace.ts";
import { Alert } from "@/ui/alert.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import {
	DialogFormBody,
	DialogFormFooter,
	DialogFormFrame,
	DialogFormHeader,
	DialogFormStep,
} from "@/ui/dialog-form.tsx";
import { SegmentedControl } from "@/ui/segmented-control.tsx";
import {
	SettingsAddMark,
	SettingsFieldRow,
	SettingsGroup,
	SettingsPage,
	SettingsRow,
	SettingsRowButton,
	SettingsRowIcon,
	SettingsStatusBadge,
	SettingsValue,
} from "@/ui/settings-page.tsx";
import {
	API_FORMATS,
	BackToModels,
	isConnected,
	modelName,
	ProviderTile,
} from "./ProviderSettings.tsx";

/**
 * The providers most people connect, listed whether or not they are, each
 * with Connect until it is. Other providers are listed once connected.
 */
const POPULAR_PRESETS: readonly ProviderPresetId[] = [
	"openrouter",
	"anthropic",
	"openai",
	"gemini",
];

/**
 * What bots think with: the models new bots and the system bots use, then the
 * popular providers and any other connected one, and adding another.
 */
export function ModelsSettings() {
	const backToModels = useBackToHere("Models");
	const providers = useModelProviders();
	const may = useWorkspacePermissions();
	// `true` for the whole list; a preset for Connect beside that provider.
	const [adding, setAdding] = useState<ProviderPresetId | true>();
	const navigate = useNavigate();
	const all = providers.data ?? [];
	const byPreset = new Map(all.map((provider) => [provider.preset, provider]));
	const others = all.filter(
		(provider) =>
			(provider.preset === null || !POPULAR_PRESETS.includes(provider.preset)) &&
			(isConnected(provider) || provider.preset === null),
	);
	const popularWithCredential = (presetId: ProviderPresetId) => {
		const provider = byPreset.get(presetId);
		return provider && !providerLacksCredential(provider) ? provider : undefined;
	};
	// What is connected leads, the popular ones in their order and then the rest; what could be follows.
	const connected = [
		...POPULAR_PRESETS.flatMap((presetId) => popularWithCredential(presetId) ?? []),
		...others,
	];
	// Nothing until the list arrives: a popular provider would read Not connected whether it is or not.
	const toConnect = providers.data
		? POPULAR_PRESETS.filter((presetId) => !popularWithCredential(presetId))
		: [];
	const providerLink = (provider: ModelProvider) => (
		<Link
			from="/$workspace"
			to="./settings/providers/$provider"
			params={{ provider: provider.id }}
			state={backToModels}
		/>
	);

	return (
		<SettingsPage
			title="Models"
			description="Which models bots can think with. Each bot picks one of these."
		>
			<SettingsGroup label="Defaults">
				<DefaultModelRow providers={all} />
				{may.configureBuiltInAgents && <SystemModelRow providers={all} />}
			</SettingsGroup>
			<SettingsGroup label="Providers">
				{providers.error && (
					<div className="px-4 py-3">
						<Alert>{failureMessage(providers.error)}</Alert>
					</div>
				)}
				{connected.map((provider) => (
					<ProviderRow key={provider.id} provider={provider} render={providerLink(provider)} />
				))}
				{toConnect.map((presetId) => {
					const preset = providerPreset(presetId);
					return (
						<SettingsRow
							key={presetId}
							icon={<ProviderTile name={preset.name} preset={presetId} />}
							label={preset.name}
							sub="Not connected"
							trailing={
								<SettingsRowButton onClick={() => setAdding(presetId)}>Connect</SettingsRowButton>
							}
						/>
					);
				})}
				<SettingsRow
					icon={<SettingsAddMark />}
					label={<span className="text-muted-foreground">Add a provider</span>}
					sub="Any OpenAI-compatible endpoint, or one on your own machine"
					chevron
					onClick={() => setAdding(true)}
				/>
			</SettingsGroup>
			<Dialog open={adding !== undefined} onOpenChange={(open) => !open && setAdding(undefined)}>
				{adding !== undefined && (
					<AddProviderDialog
						providers={all}
						startWith={adding === true ? undefined : adding}
						done={() => setAdding(undefined)}
						onAdded={async (provider) => {
							setAdding(undefined);
							await navigate({
								from: "/$workspace",
								to: "./settings/providers/$provider",
								params: { provider: provider.id },
								state: backToModels,
							});
						}}
					/>
				)}
			</Dialog>
		</SettingsPage>
	);
}

/** A provider with its credential in place: Connected while it is on, and what it holds under its name. */
function ProviderRow({
	provider,
	render,
}: {
	provider: ModelProvider;
	render: React.ReactElement;
}) {
	return (
		<SettingsRow
			icon={<ProviderTile name={provider.name} preset={provider.preset} />}
			label={provider.name}
			sub={!provider.active ? "Turned off" : credentialLine(provider)}
			trailing={provider.active && <SettingsStatusBadge>Connected</SettingsStatusBadge>}
			chevron
			render={render}
		/>
	);
}

/** What a connected provider is connected with, under its name. */
function credentialLine(provider: ModelProvider): string {
	if (presetSignsIn(provider.preset)) return "Signed in";
	if (provider.hasApiKey) return "API key set";
	return "No key needed";
}

/** The model new bots start on. */
function DefaultModelRow({ providers }: { providers: readonly ModelProvider[] }) {
	const backToModels = useBackToHere("Models");
	const current = useModels().data?.defaultModel ?? null;
	return (
		<DefaultRow
			label="Default for new bots"
			description="Any model from a connected provider"
			model={chosenModelName(providers, current)}
			render={<Link from="/$workspace" to="./settings/providers/default" state={backToModels} />}
		/>
	);
}

/**
 * One of the defaults: what it is for, and the model it is set to, at the end.
 * A phone has no room for both, so there the model goes under the name instead
 * of what it is for.
 */
function DefaultRow({
	label,
	description,
	model,
	render,
}: {
	label: string;
	description: string;
	model: string;
	render: React.ReactElement;
}) {
	return (
		<SettingsRow
			label={label}
			sub={
				<>
					<span className="max-md:hidden">{description}</span>
					<span className="block truncate text-soft-foreground text-[13px] md:hidden">{model}</span>
				</>
			}
			trailing={
				<span className="max-md:hidden">
					<SettingsValue>{model}</SettingsValue>
				</span>
			}
			chevron
			render={render}
		/>
	);
}

/** The Scribe's model stands for the system bots', since choosing one sets them all. */
function SystemModelRow({ providers }: { providers: readonly ModelProvider[] }) {
	const backToModels = useBackToHere("Models");
	const systemAgents = useBuiltInAgents();
	const current = systemAgents.data?.find((agent) => agent.key === "summarise")?.model ?? null;
	return (
		<DefaultRow
			label="Summaries"
			description="Used for thread summaries, chat titles and compacting long chats"
			model={chosenModelName(providers, current)}
			render={<Link from="/$workspace" to="./settings/providers/system" state={backToModels} />}
		/>
	);
}

function chosenModelName(providers: readonly ModelProvider[], modelId: string | null) {
	if (modelId === null) return "Not set";
	const model = providers
		.flatMap((provider) => provider.models)
		.find((candidate) => candidate.modelId === modelId);
	return model ? modelName(model) : modelId;
}

/**
 * The model new bots start on. Switching it off or removing its provider is
 * refused until another is chosen here, so once any model is on there is
 * always one.
 */
export function DefaultModelSettings() {
	const models = useModels();
	const chooseDefault = useChooseDefaultModel();
	return (
		<ModelChoicePage
			title="Default for new bots"
			description="The model a new bot starts on. Each bot can move to another model in its own settings."
			current={models.data?.defaultModel ?? null}
			pending={chooseDefault.isPending}
			choose={(modelId) => chooseDefault.mutateAsync(modelId)}
		/>
	);
}

/**
 * One model for everything Sugabots does behind the scenes: thread summaries,
 * chat titles and compacting long chats. Choosing it sets it for every system
 * bot at once.
 */
export function SystemModelSettings() {
	const systemAgents = useBuiltInAgents();
	const summarise = useChooseBuiltInAgentModel("summarise");
	const compact = useChooseBuiltInAgentModel("compact");
	const choosers = { summarise, compact };
	return (
		<ModelChoicePage
			title="Summaries"
			description="The model Sugabots uses behind the scenes: summaries, chat titles and compacting long chats. A fast, cheap model works best."
			current={systemAgents.data?.find((agent) => agent.key === "summarise")?.model ?? null}
			pending={summarise.isPending || compact.isPending}
			choose={(modelId) =>
				Promise.all(BUILT_IN_AGENT_KEYS.map((key) => choosers[key].mutateAsync(modelId)))
			}
		/>
	);
}

/** Picking one of the models that are switched on, grouped by provider. */
function ModelChoicePage({
	title,
	description,
	current,
	pending,
	choose,
}: {
	title: string;
	description: string;
	current: string | null;
	pending: boolean;
	choose: (modelId: string) => Promise<unknown>;
}) {
	const providers = useModelProviders();
	const [error, setError] = useState<unknown>();
	const groups = (providers.data ?? [])
		.filter((provider) => isConnected(provider))
		.map((provider) => ({
			provider,
			models: provider.models.filter(
				(model) => model.enabled && !effectiveCapabilities(model).includes("embeddings"),
			),
		}))
		.filter((group) => group.models.length > 0);

	async function chooseModel(modelId: string) {
		setError(undefined);
		try {
			await choose(modelId);
		} catch (cause) {
			setError(cause);
		}
	}

	return (
		<SettingsPage back={<BackToModels />} backOnWide title={title} description={description}>
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
								onClick={pending || chosen ? undefined : () => void chooseModel(model.modelId)}
								className={chosen ? "cursor-default" : undefined}
							/>
						);
					})}
				</SettingsGroup>
			))}
			<p className="-mt-5 m-0 px-0.5 text-subtle-foreground text-xs">
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
	/** A provider to open on, as Connect beside it does, with Back to the whole list. */
	startWith?: ProviderPresetId;
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
	startWith,
	done,
	onAdded,
}: {
	providers: readonly ModelProvider[];
	startWith?: ProviderPresetId;
	done: () => void;
	onAdded: (provider: ModelProvider) => Promise<void>;
}) {
	const byPreset = new Map(
		providers
			.filter((provider) => provider.preset !== null)
			.map((provider) => [provider.preset as ProviderPresetId, provider]),
	);
	const [choice, setChoice] = useState<Choice | undefined>(() =>
		startWith
			? { preset: providerPreset(startWith), existing: byPreset.get(startWith) }
			: undefined,
	);
	// Ollama is on in every workspace from the start, so being reachable is not
	// enough to leave it out: it has to have listed models.
	const available = providerCatalog.filter((preset) => {
		const existing = byPreset.get(preset.id);
		return !existing || !isConnected(existing) || existing.modelCount === 0;
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
			<DialogFormHeader title="Add provider" />
			<DialogFormBody>
				{/* The catalog runs longer than a short window, so the list scrolls inside the dialog. */}
				<div className="-mx-1 flex max-h-[min(560px,65vh)] flex-col gap-5 overflow-y-auto px-1 max-md:max-h-none max-md:overflow-visible">
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
			<DialogFormFooter onCancel={done} />
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
	const requiresApiKey = preset.credential === "api-key";
	const signInService = preset.credential === "sign-in" ? preset.signIn : undefined;
	const signsIn = signInService !== undefined;
	const typedBaseUrl = parseProviderBaseUrl(baseUrl);
	const ready = (!requiresApiKey || apiKey !== "") && (!local || typedBaseUrl !== undefined);
	const pending = actions.create.isPending || actions.update.isPending;

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!ready) return;
		setError(undefined);
		try {
			// A seeded subscription provider, like ChatGPT, already exists; its page is where the person
			// signs in, which is what switches it on.
			if (signsIn && existing) {
				await onAdded(existing);
				return;
			}
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
			<DialogFormHeader title={preset.name} onBack={onBack} backDisabled={pending} />
			<DialogFormBody>
				<SettingsGroup note={preset.hint}>
					{signInService && (
						<SettingsRow
							label={`${signInServiceNames[signInService]} account`}
							sub="Sign in after you continue"
						/>
					)}
					{local && (
						<SettingsFieldRow
							label="Server URL"
							value={baseUrl}
							onChange={setBaseUrl}
							placeholder={preset.baseUrl}
							mono
						/>
					)}
					{!signsIn && (
						<SettingsFieldRow
							label="API key"
							value={apiKey}
							onChange={setApiKey}
							placeholder={requiresApiKey ? "Paste your key" : "Optional"}
							mono
							secret
						/>
					)}
				</SettingsGroup>
				{local && baseUrl.trim() !== "" && typedBaseUrl === undefined && (
					<Alert>
						That is not a server address. A host and port, like 192.168.1.10:11434, is enough.
					</Alert>
				)}
				{error !== undefined && <Alert>{failureMessage(error)}</Alert>}
			</DialogFormBody>
			<DialogFormFooter
				action={signsIn ? "Continue" : "Add"}
				actionDisabled={!ready || pending}
				cancel={false}
			/>
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
				onBack={onBack}
				backDisabled={actions.create.isPending}
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
						label="Server URL"
						value={baseUrl}
						onChange={setBaseUrl}
						placeholder="https://llm.example.com/v1"
						mono
					/>
					<div className="flex min-h-14 items-center gap-3.5 border-border border-b px-4 py-2.5">
						<span className="flex-1 text-[13px] text-foreground">Format</span>
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
			<DialogFormFooter
				action="Add"
				actionDisabled={!ready || actions.create.isPending}
				cancel={false}
			/>
		</DialogFormStep>
	);
}

/** A preset's hint is a line or two; the picker has room for what comes before the first stop. */
function firstSentence(text: string): string {
	const stop = text.indexOf(". ");
	return stop === -1 ? text.replace(/\.$/, "") : text.slice(0, stop);
}
