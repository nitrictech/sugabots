import {
	type Agent,
	effectiveCapabilities,
	type ModelProvider,
	type ProviderModel,
	type ProviderModelCapability,
	type ProviderPresetId,
	presetRequiresApiKey,
	providerModelCapabilityCatalog,
	providerPreset,
	seededPresets,
} from "@sugabots/contracts";
import { ProviderLogo } from "@sugabots/provider-logos";
import { Link, useNavigate } from "@tanstack/react-router";
import {
	Brain,
	Eye,
	Grid2X2,
	Image,
	type LucideIcon,
	Mic,
	Pencil,
	RefreshCw,
	Search,
	Wrench,
} from "lucide-react";
import { type FormEvent, type ReactNode, useDeferredValue, useId, useState } from "react";
import { useAgents } from "@/lib/agents.ts";
import { failureMessage } from "@/lib/failure.ts";
import { useModelProviders, useProviderActions } from "@/lib/model-providers.ts";
import { parseProviderBaseUrl } from "@/lib/provider-url.ts";
import { useBackTarget } from "@/lib/settings-back.tsx";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { Dialog, DialogDescription } from "@/ui/dialog.tsx";
import {
	DialogForm,
	DialogFormBody,
	DialogFormFooter,
	DialogFormHeader,
} from "@/ui/dialog-form.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SegmentedControl } from "@/ui/segmented-control.tsx";
import {
	PageBackLink,
	SettingsAddRow,
	SettingsDanger,
	SettingsGroup,
	SettingsPage,
	SettingsRow,
	SettingsRowIcon,
} from "@/ui/settings-page.tsx";
import { Toggle } from "@/ui/toggle.tsx";

/*
 * One provider: how it is reached, which of its models bots may use, and
 * disconnecting it. A switched-off model is still listed, in its place, so
 * turning one on or off never moves the list under your pointer.
 */

/** More models than this and the list gets a search and a filter by who makes them. */
const LARGE_CATALOG = 20;

/**
 * Whether bots can reach a provider: switched on, and holding a key if it
 * needs one. Anthropic, OpenAI and Ollama exist in every workspace from the
 * start, so for them this, not existing, is what "added" means.
 */
export function isConnected(provider: ModelProvider): boolean {
	return provider.active && (!presetRequiresApiKey(provider.preset) || provider.hasApiKey);
}

/**
 * A provider's tile: its official logo for a preset, and its first letter for
 * a custom provider, which has only a name.
 */
export function ProviderTile({
	name,
	preset,
	size = 30,
}: {
	name: string;
	preset: ProviderPresetId | null;
	size?: 30 | 72;
}) {
	const large = size === 72;
	return (
		<SettingsRowIcon className={large ? "size-[72px] rounded-[22px] text-[30px]" : undefined}>
			{preset ? (
				<ProviderLogo preset={preset} className={large ? "size-10" : "size-[18px]"} />
			) : (
				name.trim().charAt(0).toUpperCase()
			)}
		</SettingsRowIcon>
	);
}

/** The bots on a model, as overlapping faces with a count past the first few. */
export function BotFaces({ bots }: { bots: readonly Agent[] }) {
	if (bots.length === 0) return null;
	const shown = bots.slice(0, bots.length > 3 ? 2 : 3);
	const more = bots.length - shown.length;
	return (
		<span aria-hidden className="flex shrink-0 items-center">
			{shown.map((bot, index) => (
				<AgentAvatar
					key={bot.id}
					color={bot.color}
					face={bot.face}
					size={22}
					className={`rounded-full shadow-[0_0_0_2px_var(--list)] ${index > 0 ? "-ml-1.5" : ""}`}
				/>
			))}
			{more > 0 && (
				<span className="-ml-1.5 grid h-[22px] min-w-[22px] place-items-center rounded-full bg-chip px-1 font-semibold text-[10.5px] text-soft-foreground shadow-[0_0_0_2px_var(--list)]">
					+{more}
				</span>
			)}
		</span>
	);
}

/** The crew bots on each model id, which is what a bot's `model` names. */
export function useBotsByModel(): (modelId: string) => Agent[] {
	const { agents } = useAgents();
	return (modelId) =>
		agents?.filter((agent) => agent.systemAgentKey === null && agent.model === modelId) ?? [];
}

export function modelName(model: Pick<ProviderModel, "displayName" | "modelId">): string {
	return model.displayName ?? model.modelId;
}

export function ProviderSettings({ providerId }: { providerId: string }) {
	const providers = useModelProviders();
	if (providers.isPending) return null;
	const provider = providers.data?.find((one) => one.id === providerId);
	if (!provider) {
		return (
			<div className="grid min-h-80 place-items-center p-6">
				<EmptyState title={providers.error ? "Could not load this provider" : "No such provider"}>
					{providers.error
						? failureMessage(providers.error)
						: "It may have been disconnected. Its models are no longer offered."}
				</EmptyState>
			</div>
		);
	}
	return <ProviderPage key={provider.id} provider={provider} />;
}

function ProviderPage({ provider }: { provider: ModelProvider }) {
	const actions = useProviderActions();
	const navigate = useNavigate();
	const [disconnecting, setDisconnecting] = useState(false);
	const preset = provider.preset === null ? null : providerPreset(provider.preset);
	// The three every workspace starts with cannot be deleted, so disconnecting
	// one takes its key away and switches it off, and adding it again brings it back.
	const seeded = provider.preset !== null && seededPresets.includes(provider.preset);
	const disconnect = seeded ? actions.update : actions.remove;

	async function confirmDisconnect() {
		try {
			if (seeded) {
				await actions.update.mutateAsync({
					providerId: provider.id,
					json: { active: false, ...(provider.hasApiKey ? { apiKey: null } : {}) },
				});
			} else {
				await actions.remove.mutateAsync({ providerId: provider.id });
			}
		} catch {
			return;
		}
		setDisconnecting(false);
		await navigate({
			from: "/$workspace",
			to: "./settings/$section",
			params: { section: "providers" },
		});
	}

	return (
		<SettingsPage
			back={<BackToModels />}
			hero={<ProviderTile name={provider.name} preset={provider.preset} size={72} />}
			title={provider.name}
		>
			{!provider.active && (
				<SettingsGroup
					note={
						actions.update.error
							? failureMessage(actions.update.error)
							: "Bots can't use its models while it is off."
					}
				>
					<SettingsRow
						label="Turned off"
						trailing={
							<Button
								size="sm"
								disabled={actions.update.isPending}
								onClick={() =>
									actions.update.mutate({ providerId: provider.id, json: { active: true } })
								}
							>
								Turn on
							</Button>
						}
					/>
				</SettingsGroup>
			)}
			<Connection provider={provider} local={preset?.hosting === "local"} />
			<Models provider={provider} />
			<SettingsDanger onClick={() => setDisconnecting(true)}>
				Disconnect {provider.name}
			</SettingsDanger>
			<DeleteDialog
				open={disconnecting}
				onOpenChange={setDisconnecting}
				title={`Disconnect ${provider.name}?`}
				description={
					seeded
						? "Its key is removed and bots can no longer use its models. You can connect it again at any time."
						: "Bots can no longer use its models. Adding it again means entering its details again."
				}
				confirmLabel="Disconnect"
				pending={disconnect.isPending}
				error={disconnect.error ? failureMessage(disconnect.error) : undefined}
				onDelete={confirmDisconnect}
			/>
		</SettingsPage>
	);
}

export function BackToModels() {
	return (
		<PageBackLink
			{...useBackTarget({
				label: "Models",
				render: (
					<Link from="/$workspace" to="./settings/$section" params={{ section: "providers" }} />
				),
			})}
		/>
	);
}

/**
 * How the provider is reached. A hosted one is its key; one you run is its
 * address and an optional key; a custom one also says which API it speaks.
 */
function Connection({ provider, local }: { provider: ModelProvider; local: boolean }) {
	const actions = useProviderActions();
	const custom = provider.preset === null;
	const error = actions.update.error ?? actions.test.error;
	const tested = actions.test.data;

	return (
		<SettingsGroup
			label="Connection"
			note={
				<span className="flex flex-col items-start gap-2">
					<Button
						variant="secondary"
						size="sm"
						disabled={actions.test.isPending}
						onClick={() => actions.test.mutate({ providerId: provider.id })}
					>
						{actions.test.isPending && <RefreshCw className="animate-spin" />}
						Test connection
					</Button>
					{tested?.reachable && <span>Connected in {tested.latencyMs} ms.</span>}
					{!tested && provider.lastTestError && (
						<span className="text-destructive-text">{provider.lastTestError}</span>
					)}
					{tested && !tested.reachable && (
						<span className="text-destructive-text">{tested.error ?? "It did not answer."}</span>
					)}
				</span>
			}
		>
			{(local || custom) && (
				<EditableRow
					label={custom ? "Address" : "Server URL"}
					value={provider.baseUrl}
					placeholder={local ? "http://localhost:11434" : "https://llm.example.com/v1"}
					pending={actions.update.isPending}
					problemWith={(typed) =>
						parseProviderBaseUrl(typed)
							? undefined
							: "That is not a server address. A host and port, like 192.168.1.10:11434, is enough."
					}
					onSave={async (typed) => {
						await actions.update.mutateAsync({
							providerId: provider.id,
							json: { baseUrl: parseProviderBaseUrl(typed) },
						});
					}}
				/>
			)}
			{custom && (
				<ConnectionRow
					label="Format"
					action={
						<SegmentedControl
							label="API format"
							options={API_FORMATS}
							value={provider.apiFormat}
							onChange={(apiFormat) =>
								actions.update.mutate({ providerId: provider.id, json: { apiFormat } })
							}
						/>
					}
				>
					{null}
				</ConnectionRow>
			)}
			<KeyRow provider={provider} optional={local || custom} />
			{error && (
				<div className="border-border border-t px-4 py-3">
					<Alert>{failureMessage(error)}</Alert>
				</div>
			)}
		</SettingsGroup>
	);
}

/** The two APIs a custom provider can speak. */
export const API_FORMATS = [
	{ value: "openai", label: "OpenAI" },
	{ value: "anthropic", label: "Anthropic" },
] as const;

/** A label, its value in the mono face, and Replace, which turns the value into a field. */
function ConnectionRow({
	label,
	children,
	action,
}: {
	label: string;
	children: ReactNode;
	action?: ReactNode;
}) {
	return (
		<div className="flex min-h-[46px] items-center gap-3 border-border border-b px-4 py-2.5 last:border-b-0">
			<span className="w-[110px] shrink-0 text-[14px] text-muted-foreground">{label}</span>
			<span className="min-w-0 flex-1">{children}</span>
			{action}
		</div>
	);
}

const valueText = "block truncate font-mono text-[13.5px] text-foreground";
const fieldText =
	"w-full min-w-0 bg-transparent font-mono text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground";

function EditableRow({
	label,
	value,
	placeholder,
	pending,
	problemWith,
	onSave,
}: {
	label: string;
	value: string;
	placeholder: string;
	pending: boolean;
	/** What is wrong with what was typed, checked before it is sent. */
	problemWith: (typed: string) => string | undefined;
	onSave: (typed: string) => Promise<void>;
}) {
	const [draft, setDraft] = useState<string>();
	const [problem, setProblem] = useState<string>();
	const id = useId();

	async function save(event: FormEvent) {
		event.preventDefault();
		if (draft === undefined) return;
		const wrong = problemWith(draft);
		setProblem(wrong);
		if (wrong) return;
		try {
			await onSave(draft);
		} catch {
			// The group says what the server refused; the field stays as typed.
			return;
		}
		setDraft(undefined);
	}

	if (draft === undefined) {
		return (
			<ConnectionRow
				label={label}
				action={
					<Button variant="link" size="bare" className="text-sm" onClick={() => setDraft(value)}>
						Change
					</Button>
				}
			>
				<span className={valueText}>{value}</span>
			</ConnectionRow>
		);
	}
	return (
		<form onSubmit={save}>
			<ConnectionRow
				label={label}
				action={
					<span className="flex shrink-0 items-center gap-3">
						<Button variant="link" size="bare" className="text-sm" type="submit" disabled={pending}>
							Save
						</Button>
						<Button
							variant="ghost"
							size="bare"
							className="text-sm"
							type="button"
							onClick={() => setDraft(undefined)}
						>
							Cancel
						</Button>
					</span>
				}
			>
				<label htmlFor={id} className="sr-only">
					{label}
				</label>
				<input
					id={id}
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					placeholder={placeholder}
					className={fieldText}
				/>
				{problem && <span className="block pt-1 text-destructive-text text-sm">{problem}</span>}
			</ConnectionRow>
		</form>
	);
}

/** The key, shown only by its last few characters once saved; Replace swaps it for a new one. */
function KeyRow({ provider, optional }: { provider: ModelProvider; optional: boolean }) {
	const actions = useProviderActions();
	const [replacing, setReplacing] = useState(!provider.hasApiKey && !optional);
	const [apiKey, setApiKey] = useState("");
	const id = useId();

	async function save(event: FormEvent) {
		event.preventDefault();
		if (!apiKey) return;
		try {
			await actions.update.mutateAsync({
				providerId: provider.id,
				// A key is what connects a provider that was disconnected.
				json: { apiKey, ...(provider.active ? {} : { active: true }) },
			});
		} catch {
			return;
		}
		setApiKey("");
		setReplacing(false);
	}

	if (!replacing) {
		return (
			<ConnectionRow
				label="API key"
				action={
					<span className="flex shrink-0 items-center gap-3">
						{optional && provider.hasApiKey && (
							<Button
								variant="ghost"
								size="bare"
								className="text-sm"
								disabled={actions.update.isPending}
								onClick={() =>
									actions.update.mutate({ providerId: provider.id, json: { apiKey: null } })
								}
							>
								Remove
							</Button>
						)}
						<Button
							variant="link"
							size="bare"
							className="text-sm"
							onClick={() => setReplacing(true)}
						>
							{provider.hasApiKey ? "Replace" : "Add"}
						</Button>
					</span>
				}
			>
				<span className={valueText}>
					{provider.hasApiKey ? `••••••${provider.apiKeyHint ?? ""}` : "None"}
				</span>
			</ConnectionRow>
		);
	}
	return (
		<form onSubmit={save}>
			<ConnectionRow
				label="API key"
				action={
					<span className="flex shrink-0 items-center gap-3">
						<Button
							variant="link"
							size="bare"
							className="text-sm"
							type="submit"
							disabled={!apiKey || actions.update.isPending}
						>
							Save
						</Button>
						{(provider.hasApiKey || optional) && (
							<Button
								variant="ghost"
								size="bare"
								className="text-sm"
								type="button"
								onClick={() => {
									setApiKey("");
									setReplacing(false);
								}}
							>
								Cancel
							</Button>
						)}
					</span>
				}
			>
				<label htmlFor={id} className="sr-only">
					{provider.name} API key
				</label>
				<input
					id={id}
					type="password"
					autoComplete="off"
					value={apiKey}
					onChange={(event) => setApiKey(event.target.value)}
					placeholder="Paste your key"
					className={fieldText}
				/>
				{actions.update.error && (
					<span role="alert" className="block pt-1 text-destructive-text text-sm">
						{failureMessage(actions.update.error)}
					</span>
				)}
			</ConnectionRow>
		</form>
	);
}

const capabilityIcons: Record<ProviderModelCapability, LucideIcon> = {
	tools: Wrench,
	vision: Eye,
	images: Image,
	audio: Mic,
	reasoning: Brain,
	embeddings: Grid2X2,
};

/** What a model can do, as small icons after its line; a capability switched off is left out. */
function CapabilityIcons({ model }: { model: ProviderModel }) {
	const on = effectiveCapabilities(model);
	return (
		<>
			{providerModelCapabilityCatalog
				.filter((entry) => on.includes(entry.key))
				.map((entry) => {
					const Icon = capabilityIcons[entry.key];
					return (
						<Icon
							key={entry.key}
							role="img"
							aria-label={entry.name}
							className="size-[13px] shrink-0"
							strokeWidth={2}
						/>
					);
				})}
		</>
	);
}

/** A catalogue of hundreds scrolls inside its group, so the search above it stays in reach. */
function ScrollingWhen({ large, children }: { large: boolean; children: ReactNode }) {
	if (!large) return children;
	return (
		<section
			aria-label="Model list"
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable from the keyboard.
			tabIndex={0}
			className="focus-ring max-h-[min(560px,60vh)] overflow-y-auto border-border border-b last:border-b-0"
		>
			{children}
		</section>
	);
}

/** Who makes a model on a provider that resells many: OpenRouter names it `maker/model`. */
function makerOf(model: ProviderModel): string | undefined {
	const slash = model.modelId.indexOf("/");
	return slash > 0 ? model.modelId.slice(0, slash) : undefined;
}

function makerLabel(maker: string): string {
	return MAKER_NAMES[maker] ?? maker.charAt(0).toUpperCase() + maker.slice(1);
}

const MAKER_NAMES: Record<string, string> = {
	openai: "OpenAI",
	"meta-llama": "Meta",
	mistralai: "Mistral",
	deepseek: "DeepSeek",
	"x-ai": "xAI",
	moonshotai: "Moonshot",
	qwen: "Qwen",
};

function Models({ provider }: { provider: ModelProvider }) {
	const actions = useProviderActions();
	const botsOn = useBotsByModel();
	const [search, setSearch] = useState("");
	const [adding, setAdding] = useState(false);
	const needle = useDeferredValue(search.trim().toLowerCase());
	const large = provider.models.length > LARGE_CATALOG;
	// Switched-on models lead, as they were when the page opened, so a row never moves under the toggle just used.
	const [onWhenOpened] = useState(
		() => new Set(provider.models.filter((model) => model.enabled).map((model) => model.id)),
	);
	const shown = provider.models
		.filter(
			(model) =>
				needle === "" ||
				`${model.modelId} ${model.displayName ?? ""}`.toLowerCase().includes(needle),
		)
		.sort((a, b) => Number(onWhenOpened.has(b.id)) - Number(onWhenOpened.has(a.id)));
	const error = actions.setModel.error ?? actions.fetchModels.error;
	const custom = provider.preset === null;

	return (
		<SettingsGroup
			label="Models"
			action={
				<Button
					variant="link"
					size="bare"
					className="text-sm"
					disabled={
						actions.fetchModels.isPending ||
						(presetRequiresApiKey(provider.preset) && !provider.hasApiKey)
					}
					onClick={() => actions.fetchModels.mutate({ providerId: provider.id })}
				>
					{actions.fetchModels.isPending ? "Refreshing…" : "Refresh list"}
				</Button>
			}
			note="Only switched-on models show up when choosing a bot's model."
		>
			{large && (
				<div className="border-border border-b p-3">
					<label className="focus-ring-within flex items-center gap-[9px] rounded-xl bg-chip px-3">
						<Search aria-hidden size={15} className="shrink-0 text-muted-foreground" />
						<input
							type="search"
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							placeholder={`Search ${provider.models.length} models`}
							aria-label="Search models"
							className="min-w-0 flex-1 bg-transparent py-[9px] text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
						/>
					</label>
				</div>
			)}
			<ScrollingWhen large={large}>
				{shown.length === 0 && (
					<SettingsRow
						label={
							needle ? "No models match." : "No models yet. Refresh the list once it is connected."
						}
					/>
				)}
				{shown.map((model) => {
					const bots = botsOn(model.modelId);
					const used =
						bots.length === 0
							? "Not used yet"
							: `${bots.length} ${bots.length === 1 ? "bot" : "bots"}`;
					const who = large ? makerLabel(makerOf(model) ?? provider.name) : used;
					return (
						<SettingsRow
							key={model.id}
							label={modelName(model)}
							sub={
								<span className="flex items-center gap-1.5">
									{who}
									<CapabilityIcons model={model} />
								</span>
							}
							trailing={
								<>
									<BotFaces bots={bots} />
									{custom && <EditCapabilities provider={provider} model={model} />}
									<Toggle
										checked={model.enabled}
										disabled={!provider.active || actions.setModel.isPending}
										label={`Bots can use ${modelName(model)}`}
										onChange={(enabled) =>
											actions.setModel.mutate({
												providerId: provider.id,
												modelId: model.id,
												enabled,
											})
										}
									/>
								</>
							}
						/>
					);
				})}
			</ScrollingWhen>
			{custom &&
				(adding ? (
					<AddModelRow provider={provider} done={() => setAdding(false)} />
				) : (
					<SettingsAddRow label="Add model" onClick={() => setAdding(true)} />
				))}
			{error && (
				<div className="border-border border-t px-4 py-3">
					<Alert>{failureMessage(error)}</Alert>
				</div>
			)}
		</SettingsGroup>
	);
}

/** A model a custom server has but does not list, added by its id. */
function AddModelRow({ provider, done }: { provider: ModelProvider; done: () => void }) {
	const actions = useProviderActions();
	const [modelId, setModelId] = useState("");
	const id = useId();
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				if (!modelId.trim()) return;
				actions.addModel.mutate(
					{ providerId: provider.id, modelId: modelId.trim() },
					{ onSuccess: done },
				);
			}}
		>
			<ConnectionRow
				label="Model ID"
				action={
					<span className="flex shrink-0 items-center gap-3">
						<Button
							variant="link"
							size="bare"
							className="text-sm"
							type="submit"
							disabled={!modelId.trim() || actions.addModel.isPending}
						>
							Add
						</Button>
						<Button variant="ghost" size="bare" className="text-sm" type="button" onClick={done}>
							Cancel
						</Button>
					</span>
				}
			>
				<label htmlFor={id} className="sr-only">
					Model ID
				</label>
				<input
					id={id}
					value={modelId}
					onChange={(event) => setModelId(event.target.value)}
					placeholder="e.g. llama-3.3-70b"
					className={fieldText}
				/>
				{actions.addModel.error && (
					<span role="alert" className="block pt-1 text-destructive-text text-sm">
						{failureMessage(actions.addModel.error)}
					</span>
				)}
			</ConnectionRow>
		</form>
	);
}

/**
 * A custom server says nothing about what its models can do, so what they can
 * is set by hand here: tools, images and the rest.
 */
function EditCapabilities({ provider, model }: { provider: ModelProvider; model: ProviderModel }) {
	const [open, setOpen] = useState(false);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<IconButton label={`What ${modelName(model)} can do`} onClick={() => setOpen(true)}>
				<Pencil />
			</IconButton>
			{open && <CapabilitiesDialog provider={provider} model={model} done={() => setOpen(false)} />}
		</Dialog>
	);
}

function CapabilitiesDialog({
	provider,
	model,
	done,
}: {
	provider: ModelProvider;
	model: ProviderModel;
	done: () => void;
}) {
	const actions = useProviderActions();
	const [chosen, setChosen] = useState<ProviderModelCapability[]>(effectiveCapabilities(model));
	// A model added by hand has whatever you say. One the server listed has what
	// it said, and each of those can only be switched off.
	const byHand = model.source === "manual";
	const offered = byHand
		? providerModelCapabilityCatalog
		: providerModelCapabilityCatalog.filter((entry) => model.capabilities.includes(entry.key));

	async function submit(event: FormEvent) {
		event.preventDefault();
		try {
			await actions.updateModel.mutateAsync({
				providerId: provider.id,
				modelId: model.id,
				json: byHand
					? { capabilities: chosen }
					: {
							disabledCapabilities: model.capabilities.filter(
								(capability) => !chosen.includes(capability),
							),
						},
			});
		} catch {
			return;
		}
		done();
	}

	return (
		<DialogForm width="compact" onSubmit={submit}>
			<DialogFormHeader title="What it can do" />
			<DialogFormBody>
				<DialogDescription className="font-mono">{model.modelId}</DialogDescription>
				{offered.length === 0 ? (
					<p className="m-0 text-md text-muted-foreground">
						The server lists nothing this model can do, so there is nothing to switch.
					</p>
				) : (
					<SettingsGroup>
						{offered.map((entry) => {
							const Icon = capabilityIcons[entry.key];
							const on = chosen.includes(entry.key);
							return (
								<SettingsRow
									key={entry.key}
									icon={<Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
									label={entry.name}
									sub={entry.description}
									trailing={
										<Toggle
											checked={on}
											label={entry.name}
											onChange={(next) =>
												setChosen(
													next
														? [...chosen, entry.key]
														: chosen.filter((capability) => capability !== entry.key),
												)
											}
										/>
									}
								/>
							);
						})}
					</SettingsGroup>
				)}
				{actions.updateModel.error && <Alert>{failureMessage(actions.updateModel.error)}</Alert>}
			</DialogFormBody>
			<DialogFormFooter
				action="Save"
				actionDisabled={actions.updateModel.isPending}
				onCancel={done}
			/>
		</DialogForm>
	);
}
