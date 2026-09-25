import {
	effectiveCapabilities,
	type ModelProvider,
	type ProviderModel,
	type ProviderModelCapability,
	providerLacksCredential,
	providerModelCapabilityCatalog,
} from "@sugabots/contracts";
import {
	Brain,
	Eye,
	Grid2X2,
	Image,
	type LucideIcon,
	Mic,
	Pencil,
	Plus,
	RefreshCw,
	Search,
	Wrench,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useProviderActions } from "@/lib/model-providers.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { Dialog, DialogClose, DialogTitle } from "@/ui/dialog.tsx";
import { DialogForm, DialogFormBody, DialogFormFooter } from "@/ui/dialog-form.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Input } from "@/ui/input.tsx";
import { SurfaceHeader, SurfaceTitle } from "@/ui/surface.tsx";
import { Toggle } from "@/ui/toggle.tsx";

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

export function ModelsList({ provider }: { provider: ModelProvider }) {
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
					disabled={providerLacksCredential(provider) || actions.fetchModels.isPending}
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
			{actionError && <Alert className="mt-2">{failureMessage(actionError)}</Alert>}
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
			setError(failureMessage(cause));
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
