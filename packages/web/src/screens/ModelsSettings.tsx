import {
	type BuiltInProvider,
	type BuiltInProviderId,
	builtInProviders,
	builtInSignsIn,
	effectiveCapabilities,
	type ModelProvider,
	providerBuiltIn,
	providerIsConnected,
	providerIsReady,
	providerIsUsable,
	signInServiceNames,
} from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { Code } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useModels } from "@/lib/bots.ts";
import { failureMessage } from "@/lib/failure.ts";
import { settingsLink } from "@/lib/links.ts";
import {
	modelName,
	useChooseDefaultModel,
	useModelProviders,
	useProviderActions,
} from "@/lib/model-providers.ts";
import { NOT_A_SERVER_ADDRESS, parseProviderBaseUrl } from "@/lib/provider-url.ts";
import { SYSTEM_BOT_KEYS, useChooseSystemBotModel, useSystemBots } from "@/lib/system-bots.ts";
import { useWorkspacePermissions } from "@/lib/workspace.ts";
import { Alert } from "@/ui/alert.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import {
	DialogFormBody,
	DialogFormFooter,
	DialogFormFrame,
	DialogFormHeader,
	DialogFormScroll,
	DialogFormStep,
} from "@/ui/dialog-form.tsx";
import {
	SettingsAddMark,
	SettingsChoiceRow,
	SettingsFieldRow,
	SettingsGroup,
	SettingsPage,
	SettingsRow,
	SettingsRowAlert,
	SettingsRowButton,
	SettingsRowIcon,
	SettingsStatusBadge,
	SettingsValue,
} from "@/ui/settings-page.tsx";
import { ModelChoiceList } from "./ModelChoiceList.tsx";
import { API_FORMATS, BackToModels, ProviderTile } from "./ProviderSettings.tsx";

/**
 * The providers most members connect, listed whether or not they are, each
 * with Connect until it is. Other providers are listed once connected.
 */
const POPULAR_BUILT_INS: readonly BuiltInProviderId[] = [
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
	const providers = useModelProviders();
	const may = useWorkspacePermissions();
	// `true` for the whole list; a built-in provider for Connect beside that provider.
	const [adding, setAdding] = useState<BuiltInProviderId | true>();
	const navigate = useNavigate();
	const all = providers.data ?? [];
	const byBuiltIn = new Map(all.map((provider) => [provider.builtIn, provider]));
	const others = all.filter(
		(provider) =>
			(provider.builtIn === null || !POPULAR_BUILT_INS.includes(provider.builtIn)) &&
			(providerIsConnected(provider) || provider.builtIn === null),
	);
	const connectedPopular = (builtInId: BuiltInProviderId) => {
		const provider = byBuiltIn.get(builtInId);
		return provider && providerIsConnected(provider) ? provider : undefined;
	};
	// Working ones lead, then failed, disabled and not connected, each the popular ones in
	// their order and then the rest; the popular ones that could be connected follow.
	const connected = [
		...POPULAR_BUILT_INS.flatMap((builtInId) => connectedPopular(builtInId) ?? []),
		...others,
	].toSorted(
		(a, b) =>
			PROVIDER_STATE_ORDER.indexOf(providerStateOf(a)) -
			PROVIDER_STATE_ORDER.indexOf(providerStateOf(b)),
	);
	// Nothing until the list arrives: a popular provider would read Not connected whether it is or not.
	const toConnect = providers.data
		? POPULAR_BUILT_INS.filter((builtInId) => !connectedPopular(builtInId))
		: [];
	const providerLink = (provider: ModelProvider) => (
		<Link {...settingsLink({ kind: "provider", provider: provider.id })} />
	);

	return (
		<SettingsPage
			title="Models"
			description="Which models bots can think with. Each bot picks one of these."
		>
			<SettingsGroup label="Defaults">
				<DefaultModelRow providers={all} />
				{may.chooseSystemModel && <SystemModelRow providers={all} />}
			</SettingsGroup>
			<SettingsGroup label="Providers">
				{providers.error && <SettingsRowAlert>{failureMessage(providers.error)}</SettingsRowAlert>}
				{connected.map((provider) => (
					<ProviderRow key={provider.id} provider={provider} render={providerLink(provider)} />
				))}
				{toConnect.map((builtInId) => {
					const builtIn = providerBuiltIn(builtInId);
					return (
						<SettingsRow
							key={builtInId}
							icon={<ProviderTile name={builtIn.name} builtIn={builtInId} />}
							label={builtIn.name}
							sub="Not connected"
							trailing={
								<SettingsRowButton onClick={() => setAdding(builtInId)}>Connect</SettingsRowButton>
							}
						/>
					);
				})}
				<SettingsRow
					icon={<SettingsAddMark />}
					label={<span className="text-muted-foreground">Add a provider</span>}
					sub="Any server that speaks OpenAI's API format, or one on your own machine"
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
							await navigate(settingsLink({ kind: "provider", provider: provider.id }));
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
	const state = providerStateOf(provider);
	return (
		<SettingsRow
			icon={<ProviderTile name={provider.name} builtIn={provider.builtIn} />}
			label={provider.name}
			sub={subLine(state, provider)}
			trailing={<ProviderStateBadge state={state} builtIn={provider.builtIn} />}
			chevron
			render={render}
		/>
	);
}

/**
 * Where a provider stands, in the order the list shows them: working; connected
 * but its last test failed, such as a key that was rejected; connected but
 * switched off, so bots can't use it until it is switched on; or not connected.
 */
const PROVIDER_STATE_ORDER = ["connected", "failed", "disabled", "not_connected"] as const;
type ProviderState = (typeof PROVIDER_STATE_ORDER)[number];

function providerStateOf(provider: ModelProvider): ProviderState {
	if (!providerIsConnected(provider)) return "not_connected";
	if (provider.status === "error") return "failed";
	if (!provider.active) return "disabled";
	return "connected";
}

function ProviderStateBadge({
	state,
	builtIn,
}: {
	state: ProviderState;
	builtIn: ModelProvider["builtIn"];
}) {
	switch (state) {
		case "connected":
			return <SettingsStatusBadge>Connected</SettingsStatusBadge>;
		case "failed":
			return (
				<SettingsStatusBadge tone="failed">
					{builtInSignsIn(builtIn) ? "Sign-in failed" : "Didn't answer"}
				</SettingsStatusBadge>
			);
		case "disabled":
			return <SettingsStatusBadge tone="off">Disabled</SettingsStatusBadge>;
		case "not_connected":
			return null;
	}
}

/** Under a provider's name: what it is connected with, or what it needs. */
function subLine(state: ProviderState, provider: ModelProvider): string {
	if (state === "not_connected") return "Not connected";
	if (state === "failed") {
		return builtInSignsIn(provider.builtIn)
			? "Sign in again to use it"
			: "Enter a new key to use it";
	}
	return credentialLine(provider);
}

/** What a connected provider is connected with, and whose subscription it signs in with. */
function credentialLine(provider: ModelProvider): string {
	if (provider.signedIn) {
		return provider.signedInAs ? `Signed in as ${provider.signedInAs.name}` : "Signed in";
	}
	if (provider.hasApiKey) return "API key set";
	return "No key needed";
}

/** The model new bots start on. */
function DefaultModelRow({ providers }: { providers: readonly ModelProvider[] }) {
	const current = useModels().data?.defaultModel ?? null;
	return (
		<DefaultRow
			label="Default for new bots"
			description="Any model from a provider that is on"
			model={chosenModelName(providers, current)}
			render={<Link {...settingsLink({ kind: "model", choice: "default" })} />}
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
					<span className="block truncate text-soft-foreground text-xs md:hidden">{model}</span>
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

/** Compaction's model stands for every system bot's, since choosing one sets them all. */
function SystemModelRow({ providers }: { providers: readonly ModelProvider[] }) {
	const systemBots = useSystemBots();
	const current = systemBots.data?.find((bot) => bot.key === "compact")?.model ?? null;
	return (
		<DefaultRow
			label="Default for system bots"
			description="Used for built-in system tasks, like compacting long chats"
			model={chosenModelName(providers, current)}
			render={<Link {...settingsLink({ kind: "model", choice: "system" })} />}
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
 * One model for everything Sugabots does behind the scenes, which is
 * compacting long chats for a bot with no model of its own. Choosing
 * it sets it for every system bot at once.
 */
export function SystemModelSettings() {
	const systemBots = useSystemBots();
	const compact = useChooseSystemBotModel("compact");
	const choosers = { compact };
	return (
		<ModelChoicePage
			title="Default for system bots"
			description="The model Sugabots uses for its own work behind the scenes, like compacting a long chat whose bot has no model of its own. A fast, cheap model works best."
			current={systemBots.data?.find((bot) => bot.key === "compact")?.model ?? null}
			pending={compact.isPending}
			choose={(modelId) =>
				Promise.all(SYSTEM_BOT_KEYS.map((key) => choosers[key].mutateAsync(modelId)))
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
	const choices = (providers.data ?? [])
		.filter(providerIsUsable)
		.flatMap((provider) =>
			provider.models
				.filter((model) => model.enabled && !effectiveCapabilities(model).includes("embeddings"))
				.map((model) => ({ ...model, providerId: provider.id, providerName: provider.name })),
		);

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
			<ModelChoiceList
				models={choices}
				chosen={current}
				onChoose={pending ? undefined : (modelId) => void chooseModel(modelId)}
				empty={providers.isPending ? undefined : "No models are switched on yet."}
			/>
			<p className="mx-0 -mt-5 mb-0 px-0.5 text-subtle-foreground text-xs">
				Only models that are switched on appear here.
			</p>
		</SettingsPage>
	);
}

type Choice = { builtIn: BuiltInProvider; existing?: ModelProvider } | "custom";

/**
 * Adding a provider, in two steps inside one dialog: which one, then what it
 * needs. The ones every workspace starts with (`seededBuiltIns`) already exist, so adding one
 * of them gives the existing record its key rather than making another.
 */
export function AddProviderDialog(props: {
	providers: readonly ModelProvider[];
	/** A provider to open on, as Connect beside it does, with Back to the whole list. */
	startWith?: BuiltInProviderId;
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
	startWith?: BuiltInProviderId;
	done: () => void;
	onAdded: (provider: ModelProvider) => Promise<void>;
}) {
	const byBuiltIn = new Map(
		providers
			.filter((provider) => provider.builtIn !== null)
			.map((provider) => [provider.builtIn as BuiltInProviderId, provider]),
	);
	const [choice, setChoice] = useState<Choice | undefined>(() =>
		startWith
			? { builtIn: providerBuiltIn(startWith), existing: byBuiltIn.get(startWith) }
			: undefined,
	);
	// Ollama is on in every workspace from the start, so being reachable is not
	// enough to leave it out: it has to have listed models.
	const available = builtInProviders.filter((builtIn) => {
		const existing = byBuiltIn.get(builtIn.id);
		return !existing || !providerIsReady(existing);
	});

	if (choice === "custom") {
		return <CustomProviderStep onBack={() => setChoice(undefined)} onAdded={onAdded} />;
	}
	if (choice) {
		return (
			<BuiltInStep
				builtIn={choice.builtIn}
				existing={choice.existing}
				onBack={() => setChoice(undefined)}
				onAdded={onAdded}
			/>
		);
	}

	const groups = [
		{ label: "Popular", builtIns: available.filter((builtIn) => builtIn.hosting === "remote") },
		{
			label: "On your own machine",
			builtIns: available.filter((builtIn) => builtIn.hosting === "local"),
		},
	].filter((group) => group.builtIns.length > 0);

	return (
		<DialogFormStep onSubmit={(event) => event.preventDefault()}>
			<DialogFormHeader title="Add provider" />
			<DialogFormBody>
				{/* The built-in providers run longer than a short window, so the list scrolls inside the dialog. */}
				<DialogFormScroll height="picker-tall">
					{groups.map((group) => (
						<SettingsGroup key={group.label} label={group.label}>
							{group.builtIns.map((builtIn) => (
								<SettingsRow
									key={builtIn.id}
									icon={<ProviderTile name={builtIn.name} builtIn={builtIn.id} />}
									label={builtIn.name}
									sub={firstSentence(builtIn.hint)}
									chevron
									onClick={() => setChoice({ builtIn, existing: byBuiltIn.get(builtIn.id) })}
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
				</DialogFormScroll>
			</DialogFormBody>
			<DialogFormFooter onCancel={done} />
		</DialogFormStep>
	);
}

function BuiltInStep({
	builtIn,
	existing,
	onBack,
	onAdded,
}: {
	builtIn: BuiltInProvider;
	existing?: ModelProvider;
	onBack: () => void;
	onAdded: (provider: ModelProvider) => Promise<void>;
}) {
	const actions = useProviderActions();
	const [apiKey, setApiKey] = useState("");
	const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? builtIn.baseUrl);
	const [error, setError] = useState<unknown>();
	const local = builtIn.hosting === "local";
	const requiresApiKey = builtIn.credential === "api-key";
	const signInService = builtIn.credential === "sign-in" ? builtIn.signIn : undefined;
	const signsIn = signInService !== undefined;
	const typedBaseUrl = parseProviderBaseUrl(baseUrl);
	const ready = (!requiresApiKey || apiKey !== "") && (!local || typedBaseUrl !== undefined);
	const pending = actions.create.isPending || actions.update.isPending;

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!ready) return;
		setError(undefined);
		try {
			// A seeded subscription provider, like ChatGPT, already exists; its page is where the member
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
						builtIn: builtIn.id,
						apiKey: apiKey || undefined,
						...(local && typedBaseUrl !== builtIn.baseUrl ? { baseUrl: typedBaseUrl } : {}),
					});
			await onAdded(added);
		} catch (cause) {
			setError(cause);
		}
	}

	return (
		<DialogFormStep onSubmit={submit}>
			<DialogFormHeader title={builtIn.name} onBack={onBack} backDisabled={pending} />
			<DialogFormBody>
				<SettingsGroup note={builtIn.hint}>
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
							placeholder={builtIn.baseUrl}
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
					<Alert>{NOT_A_SERVER_ADDRESS}</Alert>
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
					<SettingsChoiceRow
						label="Format"
						options={API_FORMATS}
						value={apiFormat}
						onChange={setApiFormat}
					/>
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

/** A built-in provider's hint is a line or two; the picker has room for what comes before the first stop. */
function firstSentence(text: string): string {
	const stop = text.indexOf(". ");
	return stop === -1 ? text.replace(/\.$/, "") : text.slice(0, stop);
}
