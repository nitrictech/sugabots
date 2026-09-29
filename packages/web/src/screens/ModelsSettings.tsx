import {
	effectiveCapabilities,
	type ModelProvider,
	type ProviderPreset,
	type ProviderPresetId,
	providerCatalog,
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
 * What bots think with: the models new bots and the system bots use, then each
 * connected provider with how many of its models are switched on, and adding
 * another.
 */
export function ModelsSettings() {
	const backToModels = useBackToHere("Models");
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
			<SettingsGroup label="Default">
				<DefaultModelRow providers={providers.data ?? []} />
				{may.configureBuiltInAgents && <SystemModelRow providers={providers.data ?? []} />}
			</SettingsGroup>
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
									state={backToModels}
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
								state: backToModels,
							});
						}}
					/>
				)}
			</Dialog>
		</SettingsPage>
	);
}

/** The model new bots start on. */
function DefaultModelRow({ providers }: { providers: readonly ModelProvider[] }) {
	const backToModels = useBackToHere("Models");
	const current = useModels().data?.defaultModel ?? null;
	return (
		<SettingsRow
			label="New bots use"
			trailing={<SettingsValue>{chosenModelName(providers, current)}</SettingsValue>}
			chevron
			render={<Link from="/$workspace" to="./settings/providers/default" state={backToModels} />}
		/>
	);
}

/** The Scribe's model stands for the system bots', since choosing one sets them all. */
function SystemModelRow({ providers }: { providers: readonly ModelProvider[] }) {
	const backToModels = useBackToHere("Models");
	const systemAgents = useBuiltInAgents();
	const current = systemAgents.data?.find((agent) => agent.key === "summarise")?.model ?? null;
	return (
		<SettingsRow
			label="System agents use"
			trailing={<SettingsValue>{chosenModelName(providers, current)}</SettingsValue>}
			chevron
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
			title="New bots"
			description="The model a new bot starts on. Each bot can move to another model in its own settings."
			current={models.data?.defaultModel ?? null}
			pending={chooseDefault.isPending}
			choose={(modelId) => chooseDefault.mutateAsync(modelId)}
		/>
	);
}

/**
 * One model for everything Sugabots does behind the scenes: thread summaries,
 * chat titles, handing a pod's floor to the right bot and compacting long chats. Choosing it sets it
 * for every system bot at once.
 */
export function SystemModelSettings() {
	const systemAgents = useBuiltInAgents();
	const summarise = useChooseBuiltInAgentModel("summarise");
	const facilitate = useChooseBuiltInAgentModel("facilitate");
	const compact = useChooseBuiltInAgentModel("compact");
	const choosers = { summarise, facilitate, compact };
	return (
		<ModelChoicePage
			title="System agents"
			description="The model Sugabots uses behind the scenes: summaries, chat titles, routing collaborations and compacting long chats. A fast, cheap model works best."
			current={systemAgents.data?.find((agent) => agent.key === "summarise")?.model ?? null}
			pending={summarise.isPending || facilitate.isPending || compact.isPending}
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
		<SettingsPage back={<BackToModels />} title={title} description={description}>
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
			<DialogFormHeader title="Add provider" />
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
