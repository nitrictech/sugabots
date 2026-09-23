import {
	effectiveCapabilities,
	type ModelProvider,
	type ProviderModel,
	type ProviderModelCapability,
	type ProviderPreset,
	type ProviderPresetId,
	presetRequiresApiKey,
	providerCatalog,
	providerModelCapabilityCatalog,
	providerPreset,
	seededPresets,
} from "@sugabots/contracts";
import {
	ArrowLeft,
	Brain,
	Check,
	CircleAlert,
	Eye,
	EyeOff,
	Grid2X2,
	Image,
	type LucideIcon,
	Mic,
	Pencil,
	Plus,
	RefreshCw,
	RotateCcw,
	Search,
	Trash2,
	Wrench,
	X,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useModelProviders, useProviderActions } from "@/lib/model-providers.ts";
import { parseProviderBaseUrl } from "@/lib/provider-url.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { Dialog, DialogClose, DialogTitle } from "@/ui/dialog.tsx";
import { DialogForm, DialogFormBody, DialogFormFooter } from "@/ui/dialog-form.tsx";
import { Field } from "@/ui/field.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Input } from "@/ui/input.tsx";
import { ProviderMark } from "@/ui/provider-mark.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select.tsx";
import { SettingsRail, SettingsRailItem, SettingsSplitView } from "@/ui/settings-rail.tsx";
import { StatusDot } from "@/ui/status-dot.tsx";
import { SurfaceHeader, SurfaceTitle } from "@/ui/surface.tsx";
import { Toggle } from "@/ui/toggle.tsx";

function message(error: unknown) {
	return failureMessage(error);
}

/**
 * Whether agents can reach this provider at all. `active` is the switch that
 * gates it — an inactive provider's models are filtered out of every lookup
 * server-side — so it is the one thing the rail reports. How the connection
 * last tested belongs beside the button that tests it, in the detail pane.
 */
function ActiveMark({ active }: { active: boolean }) {
	return (
		<StatusDot
			on={active}
			label={active ? "On" : "Off"}
			tooltip={active ? "On: agents can use this provider" : "Off: agents cannot use this provider"}
		/>
	);
}

function ProviderRail({
	providers,
	selected,
	onSelect,
	onAdd,
}: {
	providers: readonly ModelProvider[];
	selected?: ModelProvider;
	onSelect: (id: string) => void;
	onAdd: () => void;
}) {
	return (
		<SettingsRail
			label="Model providers"
			footer={
				<Button
					variant="secondary"
					className="h-11 w-full justify-start border-dashed text-base"
					onClick={onAdd}
				>
					<Plus /> Add provider
				</Button>
			}
		>
			{providers.map((provider) => (
				<SettingsRailItem
					key={provider.id}
					selected={provider.id === selected?.id}
					onClick={() => onSelect(provider.id)}
				>
					<ProviderMark preset={provider.preset} />
					<span className="min-w-0 flex-1 truncate text-base font-medium text-foreground">
						{provider.name}
					</span>
					<ActiveMark active={provider.active} />
				</SettingsRailItem>
			))}
		</SettingsRail>
	);
}

function useTestConnection(provider: ModelProvider) {
	const actions = useProviderActions();
	const pending = actions.test.isPending;
	return {
		button: (
			<Button
				variant="secondary"
				className={provider.status === "connected" ? "text-emerald-700" : ""}
				onClick={() => actions.test.mutate({ providerId: provider.id })}
				disabled={pending}
			>
				{pending ? (
					<RefreshCw className="animate-spin" />
				) : provider.status === "connected" ? (
					<span className="grid size-5 place-items-center rounded-full bg-emerald-500 text-white">
						<Check className="size-3" />
					</span>
				) : (
					<CircleAlert />
				)}
				Test connection
			</Button>
		),
		error: actions.test.error ? message(actions.test.error) : (provider.lastTestError ?? undefined),
	};
}

function CredentialStrip({ provider }: { provider: ModelProvider }) {
	const actions = useProviderActions();
	const test = useTestConnection(provider);
	const [editing, setEditing] = useState(!provider.hasApiKey);
	const [apiKey, setApiKey] = useState("");
	/**
	 * The pasted key as text rather than dots, so a stray character can be seen
	 * before it is saved. Only before: a saved key is sealed and never shown again.
	 */
	const [shown, setShown] = useState(false);
	const [error, setError] = useState<string>();
	const requiresApiKey = presetRequiresApiKey(provider.preset);

	async function save() {
		setError(undefined);
		try {
			await actions.update.mutateAsync({
				providerId: provider.id,
				json: { apiKey },
			});
			setApiKey("");
			setShown(false);
			setEditing(false);
		} catch (cause) {
			setError(message(cause));
		}
	}

	return (
		<>
			<div className="flex flex-col gap-3 rounded-xl border border-border px-4 py-4 sm:flex-row sm:items-center sm:px-5">
				{requiresApiKey && <span className="text-sm text-muted-foreground">API key</span>}
				{!requiresApiKey ? (
					<>
						<span className="text-sm text-foreground">No API key required</span>
						<span className="flex-1" />
						{test.button}
					</>
				) : editing ? (
					<>
						<Input
							aria-label={`${provider.name} API key`}
							className="min-w-0 flex-1 font-mono"
							type={shown ? "text" : "password"}
							value={apiKey}
							onChange={(event) => setApiKey(event.target.value)}
							placeholder="Paste API key"
							autoComplete="off"
							disabled={actions.update.isPending}
						/>
						<IconButton
							label={shown ? "Hide what you pasted" : "Show what you pasted"}
							onClick={() => setShown(!shown)}
						>
							{shown ? <EyeOff /> : <Eye />}
						</IconButton>
						<Button onClick={save} disabled={!apiKey || actions.update.isPending}>
							Save
						</Button>
						{provider.hasApiKey && (
							<Button variant="ghost" onClick={() => setEditing(false)}>
								Cancel
							</Button>
						)}
					</>
				) : (
					<>
						<code className="text-base text-foreground">••••••••</code>
						<Button size="bare" variant="link" className="text-sm" onClick={() => setEditing(true)}>
							Replace
						</Button>
						<span className="flex-1" />
						{test.button}
					</>
				)}
			</div>
			{(error || test.error) && <Alert className="mt-2">{error ?? test.error}</Alert>}
		</>
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

function CapabilityIcons({ model }: { model: ProviderModel }) {
	return (
		<span className="flex items-center gap-2 text-muted-foreground">
			{providerModelCapabilityCatalog
				.filter((entry) => model.capabilities.includes(entry.key))
				.map((entry) => {
					const Icon = capabilityIcons[entry.key];
					const off = model.disabledCapabilities.includes(entry.key);
					return (
						<Icon
							key={entry.key}
							className={`size-4 ${off ? "opacity-30" : ""}`}
							aria-label={off ? `${entry.name} (off)` : entry.name}
						/>
					);
				})}
		</span>
	);
}

function ModelsList({ provider }: { provider: ModelProvider }) {
	const actions = useProviderActions();
	const [search, setSearch] = useState("");
	const [adding, setAdding] = useState(false);
	const [modelId, setModelId] = useState("");
	const actionError = actions.addModel.error ?? actions.setModel.error ?? actions.fetchModels.error;
	const filtered = provider.models.filter((model) =>
		`${model.modelId} ${model.displayName ?? ""}`.toLowerCase().includes(search.toLowerCase()),
	);

	return (
		<section aria-label={`${provider.name} models`}>
			<div className="mb-4 flex items-center gap-3">
				<h3 className="text-lg font-semibold">Models</h3>
				<span className="text-base text-muted-foreground">
					{provider.enabledModelCount} of {provider.modelCount} enabled
				</span>
				<span className="flex-1" />
				{provider.preset === null && (
					<Button
						variant="ghost"
						onClick={() => setAdding(!adding)}
						disabled={actions.addModel.isPending}
					>
						<Plus /> Add model
					</Button>
				)}
				<Button
					variant="secondary"
					onClick={() => actions.fetchModels.mutate({ providerId: provider.id })}
					disabled={
						(presetRequiresApiKey(provider.preset) && !provider.hasApiKey) ||
						actions.fetchModels.isPending
					}
				>
					<RefreshCw className={actions.fetchModels.isPending ? "animate-spin" : ""} /> Refresh
				</Button>
			</div>
			{adding && (
				<div className="mb-3 flex gap-2">
					<Input
						aria-label="Model ID"
						value={modelId}
						onChange={(event) => setModelId(event.target.value)}
						placeholder="Model ID"
						disabled={actions.addModel.isPending}
					/>
					<Button
						disabled={!modelId || actions.addModel.isPending}
						onClick={() => {
							actions.addModel.mutate(
								{ providerId: provider.id, modelId },
								{
									onSuccess: () => {
										setModelId("");
										setAdding(false);
									},
								},
							);
						}}
					>
						Add
					</Button>
				</div>
			)}
			<label htmlFor={`model-search-${provider.id}`} className="relative mb-3 block">
				<span className="sr-only">Search models</span>
				<Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
				<Input
					id={`model-search-${provider.id}`}
					className="h-11 rounded-xl pl-11 text-base"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
					placeholder="Search models"
				/>
			</label>
			<div className="h-80 overflow-y-auto rounded-xl border border-border">
				{filtered.length === 0 ? (
					<p className="grid h-full place-items-center p-8 text-center text-sm text-muted-foreground">
						{search ? "No models match your search." : "No models discovered yet."}
					</p>
				) : (
					filtered.map((model) => (
						<div
							key={model.id}
							className={`flex min-h-14 items-center gap-5 border-b border-border px-4 ${model.enabled ? "" : "opacity-60"}`}
						>
							<code className="min-w-0 truncate text-base text-foreground">{model.modelId}</code>
							<CapabilityIcons model={model} />
							<span className="flex-1" />
							<EditCapabilities provider={provider} model={model} />
							<Toggle
								checked={model.enabled}
								disabled={!provider.active || actions.setModel.isPending}
								label={`${model.enabled ? "Disable" : "Enable"} ${model.modelId}`}
								onChange={(enabled) =>
									actions.setModel.mutate({
										providerId: provider.id,
										modelId: model.id,
										enabled,
									})
								}
							/>
						</div>
					))
				)}
			</div>
			{actionError && <Alert className="mt-2">{message(actionError)}</Alert>}
		</section>
	);
}

function EditCapabilities({ provider, model }: { provider: ModelProvider; model: ProviderModel }) {
	const [open, setOpen] = useState(false);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<IconButton label={`Edit ${model.modelId} capabilities`} onClick={() => setOpen(true)}>
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
	const byHand = model.source === "manual";
	const [chosen, setChosen] = useState<ProviderModelCapability[]>(
		byHand ? model.capabilities : effectiveCapabilities(model),
	);
	const [error, setError] = useState<string>();
	const has = byHand
		? providerModelCapabilityCatalog
		: providerModelCapabilityCatalog.filter((entry) => model.capabilities.includes(entry.key));
	const lacks = byHand
		? []
		: providerModelCapabilityCatalog.filter((entry) => !model.capabilities.includes(entry.key));

	async function submit(event: FormEvent) {
		event.preventDefault();
		setError(undefined);
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
			done();
		} catch (cause) {
			setError(message(cause));
		}
	}

	return (
		<DialogForm width="compact" onSubmit={submit}>
			<SurfaceHeader>
				<SurfaceTitle title={<DialogTitle>Capabilities</DialogTitle>} subtitle={model.modelId} />
			</SurfaceHeader>
			<DialogFormBody>
				<ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
					{has.map((entry) => (
						<CapabilityRow
							key={entry.key}
							entry={entry}
							on={chosen.includes(entry.key)}
							onChange={(next) =>
								setChosen(
									next
										? [...chosen, entry.key]
										: chosen.filter((capability) => capability !== entry.key),
								)
							}
						/>
					))}
					{lacks.map((entry) => (
						<CapabilityRow key={entry.key} entry={entry} on={false} />
					))}
				</ul>
				{!byHand && has.length === 0 && (
					<p className="m-0 text-md text-muted-foreground">
						The provider lists no capabilities for this model, so none can be switched on.
					</p>
				)}
				{error && <Alert>{error}</Alert>}
			</DialogFormBody>
			<DialogFormFooter>
				<DialogClose render={<Button type="button" variant="outline" size="sm" />}>
					Cancel
				</DialogClose>
				<Button type="submit" size="sm" disabled={actions.updateModel.isPending}>
					{actions.updateModel.isPending ? "Saving…" : "Save"}
				</Button>
			</DialogFormFooter>
		</DialogForm>
	);
}

function CapabilityRow({
	entry,
	on,
	onChange,
}: {
	entry: (typeof providerModelCapabilityCatalog)[number];
	on: boolean;
	onChange?: (next: boolean) => void;
}) {
	const Icon = capabilityIcons[entry.key];
	return (
		<li
			className={`flex items-center gap-4 py-3 first:pt-0 last:pb-0 ${onChange ? "" : "opacity-40"}`}
		>
			<Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
			<div className="min-w-0 flex-1">
				<span className="font-medium text-base text-foreground">{entry.name}</span>
				<p className="m-0 text-md text-muted-foreground">{entry.description}</p>
			</div>
			<Toggle
				checked={on}
				disabled={!onChange}
				label={`${on ? "Turn off" : "Turn on"} ${entry.name}`}
				onChange={(next) => onChange?.(next)}
			/>
		</li>
	);
}

/*
 * Ollama is a server you run, so its address and its key are both yours to set:
 * a different port, a path behind a proxy, a key the proxy checks. The standard
 * local install is only what the fields start at.
 *
 * Saving locks the connection, because an address that agents are already
 * running against is not something to leave a stray keystroke away from
 * changing.
 */
function LocalServerConnection({
	provider,
	preset,
}: {
	provider: ModelProvider;
	preset: ProviderPreset;
}) {
	const actions = useProviderActions();
	const test = useTestConnection(provider);
	const [editing, setEditing] = useState(false);
	const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
	const [apiKey, setApiKey] = useState<string | null>("");
	const [error, setError] = useState<string>();
	const baseUrlField = `local-base-url-${provider.id}`;
	const apiKeyField = `local-api-key-${provider.id}`;
	const typedBaseUrl = parseProviderBaseUrl(baseUrl);
	const unreadableBaseUrl = Boolean(baseUrl.trim()) && !typedBaseUrl;
	// The default is a stock local install: that address, and no key. A null
	// apiKey is a stored key marked for removal; "" is simply nothing typed.
	const keptKey = apiKey === null ? false : Boolean(apiKey) || provider.hasApiKey;
	const atDefaults = typedBaseUrl === preset.baseUrl && !keptKey;

	function edit() {
		setBaseUrl(provider.baseUrl);
		setApiKey("");
		setError(undefined);
		setEditing(true);
	}

	async function save(event: FormEvent) {
		event.preventDefault();
		setError(undefined);
		try {
			await actions.update.mutateAsync({
				providerId: provider.id,
				json: {
					baseUrl: typedBaseUrl,
					...(apiKey === "" ? {} : { apiKey }),
				},
			});
			setApiKey("");
			setEditing(false);
		} catch (cause) {
			setError(message(cause));
		}
	}

	return (
		<section aria-label={`${provider.name} connection`}>
			<h3 className="mb-3 font-semibold text-lg">Connection</h3>
			{editing ? (
				<form className="rounded-xl border border-border px-4 py-4 sm:px-5" onSubmit={save}>
					<div className="space-y-4">
						<Field id={baseUrlField} label="Server URL">
							<Input
								id={baseUrlField}
								required
								className="font-mono"
								value={baseUrl}
								onChange={(event) => setBaseUrl(event.target.value)}
								placeholder={preset.baseUrl}
								aria-invalid={unreadableBaseUrl}
								aria-describedby={unreadableBaseUrl ? `${baseUrlField}-problem` : undefined}
								disabled={actions.update.isPending}
							/>
							{unreadableBaseUrl && (
								<p id={`${baseUrlField}-problem`} className="text-destructive text-xs">
									That is not a server address — a host and port, like 192.168.1.10:11434, is
									enough.
								</p>
							)}
						</Field>
						<Field
							id={apiKeyField}
							label={provider.hasApiKey ? "Replace API key" : "API key (optional)"}
						>
							<div className="flex items-center gap-2">
								<Input
									id={apiKeyField}
									type="password"
									className="font-mono"
									autoComplete="off"
									value={apiKey ?? ""}
									onChange={(event) => setApiKey(event.target.value)}
									placeholder={
										apiKey === null
											? "Removed when you save"
											: provider.hasApiKey
												? "Leave blank to keep the current key"
												: "None"
									}
									disabled={apiKey === null || actions.update.isPending}
								/>
								{provider.hasApiKey && (
									<Button
										type="button"
										variant="ghost"
										disabled={actions.update.isPending}
										onClick={() => setApiKey(apiKey === null ? "" : null)}
									>
										{apiKey === null ? "Keep key" : "Remove key"}
									</Button>
								)}
							</div>
						</Field>
					</div>
					<div className="mt-4 flex items-center gap-2">
						<Button type="submit" disabled={!typedBaseUrl || actions.update.isPending}>
							{actions.update.isPending ? "Saving…" : "Save"}
						</Button>
						<Button
							type="button"
							variant="ghost"
							disabled={actions.update.isPending}
							onClick={() => setEditing(false)}
						>
							Cancel
						</Button>
						<span className="flex-1" />
						<Button
							type="button"
							size="bare"
							variant="link"
							className="text-sm"
							disabled={atDefaults || actions.update.isPending}
							onClick={() => {
								setBaseUrl(preset.baseUrl);
								setApiKey(provider.hasApiKey ? null : "");
							}}
						>
							<RotateCcw /> Reset to default
						</Button>
					</div>
				</form>
			) : (
				<div className="rounded-xl border border-border px-4 py-4 sm:px-5">
					<dl className="space-y-3">
						<div className="flex min-w-0 items-baseline gap-4">
							<dt className="w-20 shrink-0 text-muted-foreground text-sm">Server URL</dt>
							<dd className="min-w-0 truncate font-mono text-base text-foreground">
								{provider.baseUrl}
							</dd>
						</div>
						<div className="flex min-w-0 items-baseline gap-4">
							<dt className="w-20 shrink-0 text-muted-foreground text-sm">API key</dt>
							<dd className="min-w-0 truncate font-mono text-base text-foreground">
								{provider.hasApiKey ? `********${provider.apiKeyHint ?? ""}` : "None"}
							</dd>
						</div>
					</dl>
					<div className="mt-4 flex items-center gap-2 border-border-subtle border-t pt-4">
						<Button variant="ghost" onClick={edit}>
							<Pencil /> Edit
						</Button>
						<span className="flex-1" />
						{test.button}
					</div>
				</div>
			)}
			{(error || test.error) && <Alert className="mt-2">{error ?? test.error}</Alert>}
		</section>
	);
}

function CustomEndpoint({ provider }: { provider: ModelProvider }) {
	const actions = useProviderActions();
	const [open, setOpen] = useState(false);
	const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
	const [apiFormat, setApiFormat] = useState(provider.apiFormat);
	if (!open)
		return (
			<Button size="bare" variant="link" onClick={() => setOpen(true)}>
				Edit endpoint settings
			</Button>
		);
	return (
		<div className="grid gap-3 rounded-xl border border-border p-4 sm:grid-cols-[1fr_180px_auto] sm:items-end">
			<Field id="custom-base-url" label="Base URL">
				<Input
					id="custom-base-url"
					value={baseUrl}
					onChange={(event) => setBaseUrl(event.target.value)}
					disabled={actions.update.isPending}
				/>
			</Field>
			<Field id="custom-api-format" label="API format">
				<Select
					value={apiFormat}
					onValueChange={(value) => value && setApiFormat(value as "openai" | "anthropic")}
					disabled={actions.update.isPending}
				>
					<SelectTrigger id="custom-api-format" className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent alignItemWithTrigger={false} align="start">
						<SelectItem value="openai">OpenAI</SelectItem>
						<SelectItem value="anthropic">Anthropic</SelectItem>
					</SelectContent>
				</Select>
			</Field>
			<div className="flex gap-2">
				<Button
					variant="secondary"
					disabled={actions.update.isPending}
					onClick={() => {
						actions.update.mutate(
							{ providerId: provider.id, json: { baseUrl, apiFormat } },
							{ onSuccess: () => setOpen(false) },
						);
					}}
				>
					Save
				</Button>
				<Button
					size="icon"
					variant="ghost"
					aria-label="Cancel endpoint editing"
					onClick={() => setOpen(false)}
				>
					<X />
				</Button>
			</div>
			{actions.update.error && (
				<Alert className="sm:col-span-3">{message(actions.update.error)}</Alert>
			)}
		</div>
	);
}

function ProviderDetails({
	provider,
	onBack,
	onRemoved,
}: {
	provider: ModelProvider;
	onBack: () => void;
	onRemoved: () => void;
}) {
	const actions = useProviderActions();
	const actionError = actions.update.error ?? actions.remove.error;
	const preset = provider.preset === null ? null : providerPreset(provider.preset);
	const removable = provider.preset === null || !seededPresets.includes(provider.preset);
	return (
		<div className="min-w-0 p-5 sm:p-7 lg:p-10">
			<div className="mb-8 flex items-center gap-4">
				<Button
					size="icon"
					variant="ghost"
					className="lg:hidden"
					aria-label="Back to providers"
					onClick={onBack}
				>
					<ArrowLeft />
				</Button>
				<ProviderMark preset={provider.preset} large />
				<h2 className="min-w-0 flex-1 truncate font-display text-2xl font-semibold">
					{provider.name}
				</h2>
				<Toggle
					checked={provider.active}
					disabled={actions.update.isPending}
					label={`${provider.active ? "Deactivate" : "Activate"} ${provider.name}`}
					onChange={(active) =>
						actions.update.mutate({ providerId: provider.id, json: { active } })
					}
				/>
			</div>
			{actionError && <Alert className="mb-6">{message(actionError)}</Alert>}
			<div className="space-y-8">
				{preset?.hosting === "local" ? (
					<LocalServerConnection provider={provider} preset={preset} />
				) : (
					<CredentialStrip provider={provider} />
				)}
				{preset === null && <CustomEndpoint provider={provider} />}
				<ModelsList provider={provider} />
				{removable && (
					<Button
						variant="ghost"
						className="text-destructive hover:text-destructive"
						disabled={actions.remove.isPending}
						onClick={() => {
							if (!window.confirm(`Remove ${provider.name}?`)) return;
							actions.remove.mutate({ providerId: provider.id }, { onSuccess: onRemoved });
						}}
					>
						<Trash2 /> Remove provider
					</Button>
				)}
			</div>
		</div>
	);
}

function AddProvider({
	existing,
	onBack,
	onCreated,
}: {
	existing: readonly ModelProvider[];
	onBack: () => void;
	onCreated: (id: string) => void;
}) {
	const [choice, setChoice] = useState<ProviderPresetId | "custom">();
	const present = new Set(existing.map((provider) => provider.preset));
	const available = providerCatalog.filter((preset) => !present.has(preset.id));
	const back = choice === undefined ? onBack : () => setChoice(undefined);
	const heading =
		choice === undefined
			? "Add provider"
			: choice === "custom"
				? "Add a custom endpoint"
				: `Add ${providerPreset(choice).name}`;

	return (
		<div className="min-w-0 p-5 sm:p-7 lg:p-10">
			<div className="mb-8 flex items-center gap-3">
				<Button size="icon" variant="ghost" aria-label="Back to providers" onClick={back}>
					<ArrowLeft />
				</Button>
				<h2 className="font-display text-2xl font-semibold">{heading}</h2>
			</div>
			{choice === undefined ? (
				<CatalogPicker available={available} onChoose={setChoice} />
			) : choice === "custom" ? (
				<CustomProviderForm onCreated={onCreated} />
			) : (
				<PresetProviderForm preset={providerPreset(choice)} onCreated={onCreated} />
			)}
		</div>
	);
}

function CatalogPicker({
	available,
	onChoose,
}: {
	available: ProviderPreset[];
	onChoose: (choice: ProviderPresetId | "custom") => void;
}) {
	const groups = [
		{ title: "Hosted services", presets: available.filter(({ hosting }) => hosting === "remote") },
		{
			title: "On your own machine",
			presets: available.filter(({ hosting }) => hosting === "local"),
		},
	].filter(({ presets }) => presets.length > 0);
	return (
		<div className="max-w-2xl space-y-8">
			{groups.map(({ title, presets }) => (
				<section key={title} aria-label={title}>
					<h3 className="mb-3 font-semibold text-lg">{title}</h3>
					<ul className="grid gap-2 sm:grid-cols-2">
						{presets.map((preset) => (
							<li key={preset.id}>
								<button
									type="button"
									className="focus-ring flex w-full items-center gap-3 rounded-xl border border-border px-4 py-3 text-left hover:bg-muted"
									onClick={() => onChoose(preset.id)}
								>
									<ProviderMark preset={preset.id} />
									<span className="min-w-0">
										<span className="block font-medium text-foreground">{preset.name}</span>
										<span className="block truncate text-muted-foreground text-sm">
											{preset.hint}
										</span>
									</span>
								</button>
							</li>
						))}
					</ul>
				</section>
			))}
			<section aria-label="Custom endpoint">
				<button
					type="button"
					className="focus-ring flex w-full items-center gap-3 rounded-xl border border-border border-dashed px-4 py-3 text-left hover:bg-muted"
					onClick={() => onChoose("custom")}
				>
					<ProviderMark preset={null} />
					<span className="min-w-0">
						<span className="block font-medium text-foreground">Custom endpoint</span>
						<span className="block text-muted-foreground text-sm">
							An OpenAI- or Anthropic-compatible server the catalog does not list.
						</span>
					</span>
				</button>
			</section>
		</div>
	);
}

function PresetProviderForm({
	preset,
	onCreated,
}: {
	preset: ProviderPreset;
	onCreated: (id: string) => void;
}) {
	const actions = useProviderActions();
	const [baseUrl, setBaseUrl] = useState(preset.baseUrl);
	const [apiKey, setApiKey] = useState("");
	const [error, setError] = useState<string>();
	const local = preset.hosting === "local";
	const typedBaseUrl = parseProviderBaseUrl(baseUrl);
	const unreadableBaseUrl = Boolean(baseUrl.trim()) && !typedBaseUrl;
	const incomplete = (preset.requiresApiKey && !apiKey) || (local && !typedBaseUrl);
	return (
		<form
			className="max-w-xl space-y-5"
			onSubmit={async (event) => {
				event.preventDefault();
				setError(undefined);
				try {
					const provider = await actions.create.mutateAsync({
						preset: preset.id,
						apiKey: apiKey || undefined,
						...(local && typedBaseUrl !== preset.baseUrl ? { baseUrl: typedBaseUrl } : {}),
					});
					if (!provider) throw new Error("The provider could not be loaded");
					onCreated(provider.id);
				} catch (cause) {
					setError(message(cause));
				}
			}}
		>
			<p className="text-base text-muted-foreground">{preset.hint}</p>
			{local && (
				<Field id="new-provider-server-url" label="Server URL">
					<Input
						id="new-provider-server-url"
						required
						className="font-mono"
						value={baseUrl}
						onChange={(event) => setBaseUrl(event.target.value)}
						placeholder={preset.baseUrl}
						aria-invalid={unreadableBaseUrl}
						aria-describedby={unreadableBaseUrl ? "new-provider-server-url-problem" : undefined}
					/>
					{unreadableBaseUrl && (
						<p id="new-provider-server-url-problem" className="text-destructive text-xs">
							That is not a server address — a host and port, like 192.168.1.10:11434, is enough.
						</p>
					)}
				</Field>
			)}
			<Field
				id="new-provider-api-key"
				label={preset.requiresApiKey ? `${preset.name} API key` : "API key (optional)"}
			>
				<Input
					id="new-provider-api-key"
					type="password"
					autoComplete="off"
					required={preset.requiresApiKey}
					value={apiKey}
					onChange={(event) => setApiKey(event.target.value)}
				/>
			</Field>
			{error && <Alert>{error}</Alert>}
			<Button type="submit" disabled={incomplete || actions.create.isPending}>
				{actions.create.isPending ? "Connecting..." : `Add ${preset.name}`}
			</Button>
		</form>
	);
}

function CustomProviderForm({ onCreated }: { onCreated: (id: string) => void }) {
	const actions = useProviderActions();
	const [name, setName] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [apiFormat, setApiFormat] = useState<"openai" | "anthropic">("openai");
	const [apiKey, setApiKey] = useState("");
	const [error, setError] = useState<string>();
	return (
		<form
			className="max-w-xl space-y-5"
			onSubmit={async (event) => {
				event.preventDefault();
				setError(undefined);
				try {
					const provider = await actions.create.mutateAsync({
						name,
						baseUrl,
						apiFormat,
						apiKey: apiKey || undefined,
						customHeaders: [],
					});
					if (!provider) throw new Error("The provider could not be loaded");
					onCreated(provider.id);
				} catch (cause) {
					setError(message(cause));
				}
			}}
		>
			<Field id="new-provider-name" label="Name">
				<Input
					id="new-provider-name"
					required
					value={name}
					onChange={(event) => setName(event.target.value)}
				/>
			</Field>
			<Field id="new-provider-base-url" label="Base URL">
				<Input
					id="new-provider-base-url"
					required
					type="url"
					value={baseUrl}
					onChange={(event) => setBaseUrl(event.target.value)}
				/>
			</Field>
			<Field id="new-provider-api-format" label="API format">
				<Select
					value={apiFormat}
					onValueChange={(value) => value && setApiFormat(value as "openai" | "anthropic")}
				>
					<SelectTrigger id="new-provider-api-format" className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent alignItemWithTrigger={false} align="start">
						<SelectItem value="openai">OpenAI-compatible</SelectItem>
						<SelectItem value="anthropic">Anthropic-compatible</SelectItem>
					</SelectContent>
				</Select>
			</Field>
			<Field id="new-provider-api-key" label="API key (optional)">
				<Input
					id="new-provider-api-key"
					type="password"
					autoComplete="off"
					value={apiKey}
					onChange={(event) => setApiKey(event.target.value)}
				/>
			</Field>
			{error && <Alert>{error}</Alert>}
			<Button type="submit" disabled={actions.create.isPending}>
				{actions.create.isPending ? "Connecting..." : "Add provider"}
			</Button>
		</form>
	);
}

/** ModelProvidersSettings loads and edits workspace providers through the query client and API. */
export function ModelProvidersSettings({
	className,
	detailScrollable,
}: {
	className?: string;
	detailScrollable?: boolean;
}) {
	const query = useModelProviders();
	const providers = query.data ?? [];
	const [selectedId, setSelectedId] = useState<string>();
	const [showDetail, setShowDetail] = useState(false);
	const [adding, setAdding] = useState(false);
	const selected = providers.find((provider) => provider.id === selectedId) ?? providers[0];
	if (query.isPending)
		return <p className="p-8 text-sm text-muted-foreground">Loading providers...</p>;
	if (query.error) return <Alert className="p-8">{message(query.error)}</Alert>;
	return (
		<SettingsSplitView
			className={className}
			detailScrollable={detailScrollable}
			showDetail={showDetail}
			rail={
				<ProviderRail
					providers={providers}
					selected={adding ? undefined : selected}
					onSelect={(id) => {
						setSelectedId(id);
						setAdding(false);
						setShowDetail(true);
					}}
					onAdd={() => {
						setAdding(true);
						setShowDetail(true);
					}}
				/>
			}
			detail={
				adding ? (
					<AddProvider
						existing={providers}
						onBack={() => {
							setAdding(false);
							setShowDetail(false);
						}}
						onCreated={(id) => {
							setSelectedId(id);
							setAdding(false);
						}}
					/>
				) : selected ? (
					<ProviderDetails
						key={selected.id}
						provider={selected}
						onBack={() => setShowDetail(false)}
						onRemoved={() => {
							setSelectedId(undefined);
							setShowDetail(false);
						}}
					/>
				) : (
					<div className="grid min-h-[600px] place-items-center text-center">
						<div>
							<h2 className="font-display text-2xl font-semibold">No providers yet</h2>
							<Button className="mt-4" onClick={() => setAdding(true)}>
								<Plus /> Add provider
							</Button>
						</div>
					</div>
				)
			}
		/>
	);
}
