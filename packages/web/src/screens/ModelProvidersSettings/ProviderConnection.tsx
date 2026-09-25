import { type ModelProvider, type ProviderPreset, presetRequiresApiKey } from "@sugabots/contracts";
import { Check, CircleAlert, Eye, EyeOff, Pencil, RefreshCw, RotateCcw, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useProviderActions } from "@/lib/model-providers.ts";
import { parseProviderBaseUrl } from "@/lib/provider-url.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { Field } from "@/ui/field.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Input } from "@/ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select.tsx";

export function useTestConnection(provider: ModelProvider) {
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
		error: actions.test.error
			? failureMessage(actions.test.error)
			: (provider.lastTestError ?? undefined),
	};
}

export function CredentialStrip({ provider }: { provider: ModelProvider }) {
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
			setError(failureMessage(cause));
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

/*
 * Ollama is a server you run, so its address and its key are both yours to set:
 * a different port, a path behind a proxy, a key the proxy checks. The standard
 * local install is only what the fields start at.
 *
 * Saving locks the connection, because an address that agents are already
 * running against is not something to leave a stray keystroke away from
 * changing.
 */
export function LocalServerConnection({
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
			setError(failureMessage(cause));
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

export function CustomEndpoint({ provider }: { provider: ModelProvider }) {
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
				<Alert className="sm:col-span-3">{failureMessage(actions.update.error)}</Alert>
			)}
		</div>
	);
}
