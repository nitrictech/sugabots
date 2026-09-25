import {
	type ModelProvider,
	type ProviderPreset,
	type ProviderPresetId,
	providerCatalog,
	providerPreset,
} from "@sugabots/contracts";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useProviderActions } from "@/lib/model-providers.ts";
import { parseProviderBaseUrl } from "@/lib/provider-url.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { Field } from "@/ui/field.tsx";
import { Input } from "@/ui/input.tsx";
import { ProviderMark } from "@/ui/provider-mark.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select.tsx";

export function AddProvider({
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
	const requiresApiKey = preset.credential === "api-key";
	const incomplete = (requiresApiKey && !apiKey) || (local && !typedBaseUrl);
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
					setError(failureMessage(cause));
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
			{preset.credential === "chatgpt-sign-in" ? (
				<p className="text-base text-muted-foreground">
					Once it is added, sign in with the ChatGPT account whose plan it should use.
				</p>
			) : (
				<Field
					id="new-provider-api-key"
					label={requiresApiKey ? `${preset.name} API key` : "API key (optional)"}
				>
					<Input
						id="new-provider-api-key"
						type="password"
						autoComplete="off"
						required={requiresApiKey}
						value={apiKey}
						onChange={(event) => setApiKey(event.target.value)}
					/>
				</Field>
			)}
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
					setError(failureMessage(cause));
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
