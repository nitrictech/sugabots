import {
	type Connection,
	type ConnectionPreset,
	connectionCatalog,
	connectionPresetFor,
	connectionToolMutating,
	hueFromText,
	type ToolApprovalRule,
} from "@sugabots/contracts";
import { Ellipsis, Eye, EyeOff, Plus, Search } from "lucide-react";
import { type FormEvent, useState } from "react";
import {
	useConnectionActions,
	useConnections,
	useRevokeToolApprovalRule,
	useToolApprovalRules,
} from "@/lib/connections.ts";
import { failureMessage } from "@/lib/failure.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/ui/dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { Field } from "@/ui/field.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Input } from "@/ui/input.tsx";

export function ConnectionsSettings({
	podId,
	canManage,
	signInError,
}: {
	podId: string;
	canManage: boolean;
	signInError?: string;
}) {
	const connections = useConnections(podId);
	const rules = useToolApprovalRules(podId);
	const [custom, setCustom] = useState(false);
	if (connections.isPending || rules.isPending) return null;
	if (connections.isError || rules.isError)
		return <Alert>{failureMessage(connections.error ?? rules.error)}</Alert>;
	const listed = connections.data;
	const taken = new Set(listed.map((one) => connectionPresetFor(one.url)?.id));
	const catalog = connectionCatalog.filter((preset) => !taken.has(preset.id));

	return (
		<section aria-label="Connections" className="flex max-w-3xl flex-col gap-7">
			<header>
				<h2 className="font-semibold text-heading text-lg">Connections</h2>
				<p className="text-muted-foreground text-sm">
					Every agent in this pod can use the actions enabled here.
				</p>
			</header>
			{signInError && <Alert>Signing in did not finish: {signInError}</Alert>}

			{listed.length > 0 && (
				<div className="flex flex-col gap-4">
					{listed.map((one) => (
						<ConnectionRow
							key={one.id}
							connection={one}
							podId={podId}
							canManage={canManage}
							rules={rules.data.filter((rule) => rule.connectionId === one.id)}
						/>
					))}
				</div>
			)}

			{canManage && (catalog.length > 0 || custom) && (
				<div className="flex flex-col gap-3 border-border-subtle border-t pt-6">
					<h3 className="font-semibold text-heading text-md">Add a connection</h3>
					{catalog.length > 0 && !custom && (
						<ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2">
							{catalog.map((preset) => (
								<CatalogCard key={preset.id} preset={preset} podId={podId} />
							))}
						</ul>
					)}
					{custom ? (
						<AddByUrl podId={podId} done={() => setCustom(false)} />
					) : (
						<Button
							size="bare"
							variant="link"
							className="self-start"
							onClick={() => setCustom(true)}
						>
							Connect by URL
						</Button>
					)}
				</div>
			)}
			{!canManage && listed.length === 0 && (
				<p className="text-muted-foreground text-md">No connections in this pod.</p>
			)}
		</section>
	);
}

function ConnectionRow({
	connection,
	podId,
	canManage,
	rules,
}: {
	connection: Connection;
	podId: string;
	canManage: boolean;
	rules: ToolApprovalRule[];
}) {
	const actions = useConnectionActions(podId);
	const [replacing, setReplacing] = useState(false);
	const [error, setError] = useState<string>();
	const pending = actions.update.isPending || actions.remove.isPending || actions.test.isPending;
	const latest =
		actions.test.variables?.connectionId === connection.id ? actions.test.data : undefined;
	const preset = connectionPresetFor(connection.url);

	async function act(work: () => Promise<unknown>) {
		setError(undefined);
		try {
			await work();
		} catch (cause) {
			setError(failureMessage(cause));
		}
	}
	const update = (json: Parameters<typeof actions.update.mutateAsync>[0]["json"]) =>
		act(() => actions.update.mutateAsync({ connectionId: connection.id, json }));
	const test = () => act(() => actions.test.mutateAsync({ connectionId: connection.id }));
	const signIn = () => act(() => actions.signIn.mutateAsync({ connectionId: connection.id }));
	const oauth = connection.auth === "oauth";

	return (
		<article
			aria-label={connection.name}
			className="overflow-hidden rounded-2xl border border-border bg-card"
		>
			<div className="flex min-h-16 flex-wrap items-center gap-3 px-4 py-3 sm:flex-nowrap">
				<ConnectionMark
					presetId={preset?.id}
					name={connection.name}
					hue={preset?.hue ?? hueFromText(connection.name)}
				/>
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="truncate font-semibold text-base text-foreground">
						{connection.name}
					</span>
					{preset && <span className="text-muted-foreground text-sm">{preset.description}</span>}
				</span>
				<Standing
					connection={connection}
					onReconnect={oauth ? signIn : test}
					pending={pending || actions.signIn.isPending}
					canManage={canManage}
				/>
				{canManage && (
					<Button
						size="sm"
						variant={connection.enabled ? "outline" : "default"}
						disabled={pending}
						onClick={() => update({ enabled: !connection.enabled })}
					>
						{connection.enabled ? "Turn off" : "Turn on"}
					</Button>
				)}
				{canManage && (
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<IconButton label={`${connection.name} options`} variant="outline">
									<Ellipsis />
								</IconButton>
							}
						/>
						<DropdownMenuContent align="end" className="min-w-52">
							<DropdownMenuItem onClick={test}>Check connection</DropdownMenuItem>
							{oauth ? (
								<DropdownMenuItem onClick={signIn}>Sign in again</DropdownMenuItem>
							) : (
								connection.secretHeader !== null && (
									<DropdownMenuItem onClick={() => setReplacing(true)}>
										{connection.hasSecret ? "Replace secret" : "Add secret"}
									</DropdownMenuItem>
								)
							)}
							<DropdownMenuSeparator />
							<DropdownMenuItem
								variant="destructive"
								onClick={() =>
									act(() => actions.remove.mutateAsync({ connectionId: connection.id }))
								}
							>
								Remove
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</div>
			{(latest || error) && (
				<p className="border-border-subtle border-t px-4 py-3 text-muted-foreground text-sm">
					{error ??
						(latest?.reachable
							? `Found ${latest.tools ?? 0} actions in ${latest.latencyMs} ms.`
							: (latest?.error ?? "The server did not answer."))}
				</p>
			)}
			{replacing && (
				<div className="border-border-subtle border-t px-4 pt-3">
					<SecretForm
						connection={connection}
						pending={pending}
						save={(secret) => update({ secret })}
						done={() => setReplacing(false)}
					/>
				</div>
			)}
			<ToolsList
				connection={connection}
				podId={podId}
				canManage={canManage}
				update={update}
				rules={rules}
			/>
		</article>
	);
}

/** On, off, or asking to be signed in or reconnected: the one word the row says about itself. */
function Standing({
	connection,
	onReconnect,
	pending,
	canManage,
}: {
	connection: Connection;
	onReconnect: () => void;
	pending: boolean;
	canManage: boolean;
}) {
	if (!connection.signedIn) {
		if (!canManage) return <span className="text-muted-foreground text-sm">Sign-in required</span>;
		return (
			<Button size="sm" onClick={onReconnect} disabled={pending}>
				Sign in
			</Button>
		);
	}
	if (connection.status === "error") {
		if (!canManage) return <span className="text-warning text-sm">Needs attention</span>;
		return (
			<Button
				size="sm"
				variant="outline"
				className="border-warning text-warning"
				onClick={onReconnect}
				disabled={pending}
			>
				Reconnect
			</Button>
		);
	}
	if (!connection.enabled && !canManage) {
		return <span className="text-muted-foreground text-sm">Off</span>;
	}
	return null;
}

function SecretForm({
	connection,
	pending,
	save,
	done,
}: {
	connection: Connection;
	pending: boolean;
	save: (secret: string) => Promise<unknown>;
	done: () => void;
}) {
	const [secret, setSecret] = useState("");
	const [shown, setShown] = useState(false);
	return (
		<form
			className="flex gap-2 pb-3"
			onSubmit={async (event) => {
				event.preventDefault();
				if (!secret) return;
				await save(secret);
				done();
			}}
		>
			<Input
				aria-label={`${connection.name} secret`}
				className="min-w-0 flex-1 font-mono"
				type={shown ? "text" : "password"}
				autoComplete="off"
				value={secret}
				onChange={(event) => setSecret(event.target.value)}
				placeholder={`Sent as ${connection.secretHeader}`}
				disabled={pending}
			/>
			<IconButton
				label={shown ? "Hide what you pasted" : "Show what you pasted"}
				size="lg"
				onClick={() => setShown(!shown)}
			>
				{shown ? <EyeOff /> : <Eye />}
			</IconButton>
			<Button type="submit" disabled={!secret || pending}>
				Save secret
			</Button>
			<Button type="button" variant="ghost" onClick={done}>
				Cancel
			</Button>
		</form>
	);
}

function ToolsList({
	connection,
	podId,
	canManage,
	update,
	rules,
}: {
	connection: Connection;
	podId: string;
	canManage: boolean;
	update: (json: { allowMutating: boolean }) => Promise<void>;
	rules: ToolApprovalRule[];
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const revoke = useRevokeToolApprovalRule(podId);
	if (connection.tools.length === 0) {
		return (
			<p className="border-border-subtle border-t px-4 py-3 text-muted-foreground text-sm">
				No actions discovered yet. Check the connection to see what it can do.
			</p>
		);
	}

	const mutating = connection.tools.filter(connectionToolMutating);
	const needle = query.trim().toLowerCase();
	const filtered = connection.tools.filter(
		(tool) =>
			needle === "" ||
			tool.name.toLowerCase().includes(needle) ||
			tool.description?.toLowerCase().includes(needle),
	);

	return (
		<div className="flex flex-wrap items-center gap-3 border-border-subtle border-t px-4 py-3">
			<span className="text-muted-foreground text-sm">{connection.tools.length} tools</span>
			{mutating.length > 0 && (
				<span className="text-muted-foreground text-sm">
					{connection.allowMutating ? "Read and write" : "Read only"}
				</span>
			)}
			<div className="ml-auto flex items-center gap-2">
				{canManage && mutating.length > 0 && (
					<Button
						size="sm"
						variant="outline"
						onClick={() => update({ allowMutating: !connection.allowMutating })}
					>
						{connection.allowMutating ? "Make read only" : "Allow changes"}
					</Button>
				)}
				<Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
					View tools
				</Button>
			</div>

			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="grid max-h-[80vh] grid-rows-[auto_auto_minmax(0,1fr)] sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle>{connection.name} tools</DialogTitle>
						<DialogDescription>
							{connection.tools.length} tools
							{mutating.length > 0 && ` · ${mutating.length} can make changes`}
						</DialogDescription>
					</DialogHeader>
					<label htmlFor={`${connection.id}-tool-search`} className="relative block">
						<span className="sr-only">Search tools</span>
						<Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							id={`${connection.id}-tool-search`}
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="Search tools"
							className="pl-9"
						/>
					</label>
					<div className="min-h-0 overflow-y-auto pr-1">
						{filtered.length === 0 ? (
							<p className="py-8 text-center text-muted-foreground">No matching tools.</p>
						) : (
							<ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
								{filtered.map((tool) => {
									const changesData = connectionToolMutating(tool);
									const toolRules = rules.filter((rule) => rule.toolName === tool.name);
									return (
										<li key={tool.name}>
											<details className="group py-3">
												<summary className="flex cursor-pointer list-none items-baseline gap-2 marker:hidden">
													<span className="font-medium text-foreground group-open:text-primary">
														{readableToolName(tool.name)}
													</span>
													<span className="ml-auto text-muted-foreground text-xs">
														{changesData ? "Makes changes" : "Read"}
													</span>
												</summary>
												{tool.description && (
													<p className="mt-2 mb-0 max-w-prose whitespace-pre-wrap text-muted-foreground text-sm">
														{tool.description}
													</p>
												)}
												{changesData && (
													<div className="mt-2 flex flex-col gap-1.5">
														{toolRules.length === 0 ? (
															<span className="text-muted-foreground text-xs">Ask first</span>
														) : (
															toolRules.map((rule) => (
																<span key={rule.id} className="flex items-center gap-2 text-xs">
																	<span className="text-foreground">
																		Always allowed for {rule.agentName}
																	</span>
																	{canManage && (
																		<Button
																			size="bare"
																			variant="link"
																			disabled={revoke.isPending}
																			onClick={() => revoke.mutate(rule.id)}
																		>
																			Return to ask first
																		</Button>
																	)}
																</span>
															))
														)}
													</div>
												)}
											</details>
										</li>
									);
								})}
							</ul>
						)}
					</div>
				</DialogContent>
			</Dialog>
		</div>
	);
}

export function readableToolName(name: string): string {
	return name.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/*
 * A known server, waiting to be connected: its logo, a line on what it
 * reaches, and a plus that signs the pod owner in. The plus makes the
 * connection and sends the browser to the server to sign in, in one step;
 * the API's callback brings it back here with the server connected.
 */
function CatalogCard({ preset, podId }: { preset: ConnectionPreset; podId: string }) {
	const actions = useConnectionActions(podId);
	const [error, setError] = useState<string>();

	async function connect() {
		setError(undefined);
		try {
			await actions.connect.mutateAsync({ name: preset.name, url: preset.url });
		} catch (cause) {
			setError(failureMessage(cause));
		}
	}

	return (
		<li className="flex items-center gap-3.5 rounded-2xl border border-border bg-card px-4 py-3">
			<ConnectionMark presetId={preset.id} name={preset.name} hue={preset.hue} />
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate font-medium text-base text-foreground">{preset.name}</span>
				<span className="truncate text-muted-foreground text-sm" title={error}>
					{error ?? preset.description}
				</span>
			</span>
			<IconButton
				label={`Connect ${preset.name}`}
				variant="outline"
				disabled={actions.connect.isPending}
				onClick={connect}
			>
				<Plus />
			</IconButton>
		</li>
	);
}

/** Any other MCP server, by its address. */
function AddByUrl({ podId, done }: { podId: string; done: () => void }) {
	const actions = useConnectionActions(podId);
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [secretHeader, setSecretHeader] = useState("Authorization");
	const [secret, setSecret] = useState("");
	const [error, setError] = useState<string>();

	async function save(event: FormEvent) {
		event.preventDefault();
		setError(undefined);
		try {
			await actions.create.mutateAsync({
				name,
				url,
				...(secretHeader ? { secretHeader } : {}),
				...(secret ? { secret } : {}),
			});
			done();
		} catch (cause) {
			setError(failureMessage(cause));
		}
	}

	return (
		<form
			onSubmit={save}
			aria-label="Connect by URL"
			className="flex flex-col gap-4 rounded-2xl border border-border bg-card px-5 py-4"
		>
			<h3 className="font-semibold text-heading text-md">Connect by URL</h3>
			<Field id="connection-name" label="Name">
				<Input
					id="connection-name"
					value={name}
					onChange={(event) => setName(event.target.value)}
					placeholder="Team wiki"
					required
					disabled={actions.create.isPending}
				/>
			</Field>
			<Field id="connection-url" label="MCP server URL">
				<Input
					id="connection-url"
					className="font-mono"
					value={url}
					onChange={(event) => setUrl(event.target.value)}
					placeholder="https://mcp.example.com/mcp"
					required
					disabled={actions.create.isPending}
				/>
			</Field>
			<div className="grid gap-4 sm:grid-cols-2">
				<Field id="connection-secret-header" label="Secret header">
					<Input
						id="connection-secret-header"
						className="font-mono"
						value={secretHeader}
						onChange={(event) => setSecretHeader(event.target.value)}
						disabled={actions.create.isPending}
					/>
				</Field>
				<Field id="connection-secret" label="Secret (optional)">
					<Input
						id="connection-secret"
						type="password"
						className="font-mono"
						autoComplete="off"
						value={secret}
						onChange={(event) => setSecret(event.target.value)}
						placeholder="Bearer …"
						disabled={actions.create.isPending}
					/>
				</Field>
			</div>
			<div className="flex gap-2">
				<Button type="submit" disabled={!name || !url || actions.create.isPending}>
					{actions.create.isPending ? "Adding…" : "Add"}
				</Button>
				<Button type="button" variant="ghost" onClick={done} disabled={actions.create.isPending}>
					Cancel
				</Button>
			</div>
			{error && <Alert>{error}</Alert>}
		</form>
	);
}
