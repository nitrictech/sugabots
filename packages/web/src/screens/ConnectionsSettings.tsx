import {
	type Connection,
	type ConnectionAccess,
	type ConnectionPreset,
	type ConnectionTool,
	connectionCatalog,
	connectionPresetFor,
	connectionToolMutating,
} from "@sugabots/contracts";
import { ArrowUpRight, Code, Search } from "lucide-react";
import { type FormEvent, useDeferredValue, useState } from "react";
import { bearerAuthorization, useConnectionActions, useConnections } from "@/lib/connections.ts";
import { failureMessage } from "@/lib/failure.ts";
import { wordsFromKey } from "@/lib/tool-names.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
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
	SettingsDanger,
	SettingsFieldRow,
	SettingsGroup,
	SettingsRow,
	SettingsRowIcon,
	SettingsValue,
} from "@/ui/settings-page.tsx";

/*
 * The apps a pod's bots can reach, as one group on the pod's page: each with
 * Allow, Ask or Off for what its bots may do there, and whatever it needs (a
 * sign-in, a reconnect) on its line. A row opens the connection itself: its
 * address, its tools and removing it. Adding one is a dialog: the app, then
 * its sign-in and one approval control, or any other server by its address.
 */

const accessLabel: Record<ConnectionAccess, string> = { allow: "Allow", ask: "Ask", off: "Off" };
const accessOptions = (["allow", "ask", "off"] as const).map((value) => ({
	value,
	label: accessLabel[value],
}));
/** For an app being added, which is added to be used. */
const addingOptions = (["allow", "ask"] as const).map((value) => ({
	value,
	label: accessLabel[value],
}));

export function ConnectionsSettings({
	podId,
	podName,
	canManage,
	signInError,
}: {
	podId: string;
	podName: string;
	canManage: boolean;
	/** Why the OAuth sign-in that just returned here did not finish, in our own words. */
	signInError?: string;
}) {
	const connections = useConnections(podId);
	const [adding, setAdding] = useState(false);
	const [open, setOpen] = useState<string>();
	if (connections.isPending) return null;
	if (connections.isError) return <Alert>{failureMessage(connections.error)}</Alert>;
	const listed = connections.data;
	const taken = new Set(listed.map((one) => connectionPresetFor(one.url)?.id));
	const opened = listed.find((one) => one.id === open);

	return (
		<>
			{signInError && <Alert>Signing in did not finish: {signInError}</Alert>}
			<SettingsGroup
				label="Connections"
				note="Every bot in this pod can use these. Ask means it waits for your approval first."
			>
				{listed.map((one) => (
					<ConnectionRow
						key={one.id}
						connection={one}
						podId={podId}
						canManage={canManage}
						onOpen={() => setOpen(one.id)}
					/>
				))}
				{listed.length === 0 && !canManage && <SettingsRow label="No connections in this pod." />}
				{canManage && <SettingsAddRow label="Add connection" onClick={() => setAdding(true)} />}
			</SettingsGroup>
			<Dialog open={adding} onOpenChange={setAdding}>
				{adding && (
					<AddConnectionDialog
						podId={podId}
						podName={podName}
						available={connectionCatalog.filter((preset) => !taken.has(preset.id))}
						done={() => setAdding(false)}
					/>
				)}
			</Dialog>
			<Dialog open={opened !== undefined} onOpenChange={(next) => !next && setOpen(undefined)}>
				{opened && (
					<ConnectionDialog
						connection={opened}
						podId={podId}
						canManage={canManage}
						done={() => setOpen(undefined)}
					/>
				)}
			</Dialog>
		</>
	);
}

/** What a connection's line says under its name: what it reaches, or what it needs. */
function lineFor(connection: Connection): string {
	if (!connection.signedIn) return "Not signed in yet";
	if (connection.status === "error") return connection.lastTestError ?? "The last check failed";
	const preset = connectionPresetFor(connection.url);
	if (preset) return preset.description;
	const count = connection.tools.length;
	return count === 0 ? "No actions found yet" : `${count} ${count === 1 ? "action" : "actions"}`;
}

function ConnectionRow({
	connection,
	podId,
	canManage,
	onOpen,
}: {
	connection: Connection;
	podId: string;
	canManage: boolean;
	onOpen: () => void;
}) {
	const actions = useConnectionActions(podId);
	const preset = connectionPresetFor(connection.url);
	const needsSignIn = !connection.signedIn;
	const failing = connection.signedIn && connection.status === "error";
	const pending = actions.update.isPending || actions.signIn.isPending || actions.test.isPending;
	const error = actions.update.error ?? actions.signIn.error ?? actions.test.error;
	const reconnect = () =>
		connection.auth === "oauth"
			? actions.signIn.mutate({ connectionId: connection.id })
			: actions.test.mutate({ connectionId: connection.id });
	const checked =
		actions.test.variables?.connectionId === connection.id ? actions.test.data : undefined;
	const line = error
		? failureMessage(error)
		: checked
			? checked.reachable
				? `Found ${checked.tools ?? 0} actions in ${checked.latencyMs} ms.`
				: (checked.error ?? "The server did not answer.")
			: lineFor(connection);

	return (
		<article
			aria-label={connection.name}
			className="flex min-h-[58px] items-center gap-3 border-border border-b px-4 py-2.5 last:border-b-0 max-md:flex-wrap"
		>
			<button
				type="button"
				onClick={onOpen}
				aria-haspopup="dialog"
				aria-label={`About ${connection.name}`}
				className="focus-ring flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left max-md:min-w-[60%]"
			>
				<ConnectionMark presetId={preset?.id} name={connection.name} size="tile" />
				<span className="flex min-w-0 flex-1 flex-col gap-px">
					<span className="truncate font-medium text-[14.5px] text-foreground">
						{connection.name}
					</span>
					<span
						className={`truncate text-sm ${failing || error ? "text-destructive-text" : "text-muted-foreground"}`}
					>
						{line}
					</span>
				</span>
			</button>
			{/* On a phone these wrap below the name, kept to the right. */}
			<span className="ml-auto flex shrink-0 items-center gap-2">
				{canManage && (needsSignIn || failing) && (
					<Button size="sm" variant="secondary" disabled={pending} onClick={reconnect}>
						{needsSignIn ? "Sign in" : "Reconnect"}
					</Button>
				)}
				{canManage ? (
					<SegmentedControl
						label={`What bots may do with ${connection.name}`}
						options={accessOptions}
						value={connection.access}
						onChange={(access) => {
							if (!pending)
								actions.update.mutate({ connectionId: connection.id, json: { access } });
						}}
					/>
				) : (
					<SettingsValue>{accessLabel[connection.access]}</SettingsValue>
				)}
			</span>
		</article>
	);
}

/** How a tool runs under the connection's access: straight away, after a yes, or not at all. */
function toolGroups(
	connection: Connection,
): { label: string; note?: string; tools: ConnectionTool[] }[] {
	const tools = connection.tools;
	if (connection.access === "off") {
		return [{ label: "Tools", note: "Off, so bots in this pod can't use these.", tools }];
	}
	if (connection.access === "ask") return [{ label: "Asks first", tools }];
	return [
		{ label: "Asks first", tools: tools.filter(connectionToolMutating) },
		{ label: "Runs freely", tools: tools.filter((tool) => !connectionToolMutating(tool)) },
	];
}

/**
 * One of a connection's tools: its name in words, and what it does, unless
 * the description only says the name again.
 */
export function ConnectionToolRow({ tool }: { tool: ConnectionTool }) {
	const label = wordsFromKey(tool.name);
	const description = tool.description?.trim();
	const says = description && description.toLowerCase() !== label.toLowerCase();
	return <SettingsRow label={label} sub={says ? description : undefined} />;
}

/**
 * One connection: where it is, how it signs in, a check that it answers, what
 * its tools do under its access, and removing it.
 */
function ConnectionDialog({
	connection,
	podId,
	canManage,
	done,
}: {
	connection: Connection;
	podId: string;
	canManage: boolean;
	done: () => void;
}) {
	const actions = useConnectionActions(podId);
	const [replacing, setReplacing] = useState(false);
	const [secret, setSecret] = useState("");
	const [removing, setRemoving] = useState(false);
	const [query, setQuery] = useState("");
	const needle = useDeferredValue(query.trim().toLowerCase());
	const preset = connectionPresetFor(connection.url);
	const oauth = connection.auth === "oauth";
	const checked =
		actions.test.variables?.connectionId === connection.id ? actions.test.data : undefined;
	const checkFailed = checked ? !checked.reachable : connection.status === "error";
	const error = actions.update.error ?? actions.signIn.error ?? actions.test.error;
	const matches = (tool: ConnectionTool) =>
		needle === "" ||
		tool.name.toLowerCase().includes(needle) ||
		tool.description?.toLowerCase().includes(needle);

	async function saveSecret(event: FormEvent) {
		event.preventDefault();
		if (!secret) return;
		try {
			await actions.update.mutateAsync({ connectionId: connection.id, json: { secret } });
		} catch {
			return;
		}
		setSecret("");
		setReplacing(false);
	}

	return (
		<DialogFormFrame>
			<DialogFormStep
				onSubmit={(event) => {
					event.preventDefault();
					done();
				}}
			>
				<DialogFormHeader title={connection.name} />
				<DialogFormBody>
					<div className="max-h-[min(620px,70vh)] -mx-1 flex flex-col gap-5 overflow-y-auto px-1">
						<div className="flex flex-col items-center gap-1.5 text-center">
							<ConnectionMark presetId={preset?.id} name={connection.name} />
							<span className="max-w-full truncate font-mono text-[12.5px] text-muted-foreground">
								{connection.url}
							</span>
						</div>
						<SettingsGroup
							label="Connection"
							note={
								checkFailed && (
									<a
										href={TROUBLESHOOTING_URL}
										target="_blank"
										rel="noreferrer"
										className="focus-ring rounded-sm font-medium text-link"
									>
										How to fix this
									</a>
								)
							}
						>
							{oauth ? (
								<SettingsRow
									label="Sign-in"
									sub={connection.signedIn ? "Signed in" : "Not signed in yet"}
									trailing={
										canManage && (
											<Button
												size="sm"
												variant="secondary"
												disabled={actions.signIn.isPending}
												onClick={() => actions.signIn.mutate({ connectionId: connection.id })}
											>
												{connection.signedIn ? "Sign in again" : "Sign in"}
											</Button>
										)
									}
								/>
							) : (
								connection.secretHeader !== null && (
									<SettingsRow
										label="Secret"
										sub={`Sent as ${connection.secretHeader}`}
										trailing={
											canManage && (
												<Button
													size="sm"
													variant="secondary"
													onClick={() => setReplacing(!replacing)}
												>
													{connection.hasSecret ? "Replace" : "Add"}
												</Button>
											)
										}
									/>
								)
							)}
							{replacing && (
								// A form of its own inside the dialog's, which Save submits alone.
								<div className="flex items-center gap-3 border-border border-t px-4 py-2.5">
									<input
										aria-label={`${connection.name} secret`}
										type="password"
										autoComplete="off"
										value={secret}
										onChange={(event) => setSecret(event.target.value)}
										onKeyDown={(event) => {
											if (event.key === "Enter") void saveSecret(event);
										}}
										placeholder="Paste the new secret"
										className="min-w-0 flex-1 bg-transparent font-mono text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground"
									/>
									<Button
										size="sm"
										disabled={!secret || actions.update.isPending}
										onClick={(event) => void saveSecret(event)}
									>
										Save
									</Button>
								</div>
							)}
							<SettingsRow
								label="Check connection"
								sub={
									checked
										? checked.reachable
											? `Found ${checked.tools ?? 0} actions in ${checked.latencyMs} ms.`
											: (checked.error ?? "The server did not answer.")
										: connection.status === "error"
											? (connection.lastTestError ?? "The last check failed.")
											: "Ask the server what it can do."
								}
								trailing={
									<Button
										size="sm"
										variant="secondary"
										disabled={actions.test.isPending}
										onClick={() => actions.test.mutate({ connectionId: connection.id })}
									>
										{actions.test.isPending ? "Checking…" : "Check"}
									</Button>
								}
							/>
						</SettingsGroup>
						{error && <Alert>{failureMessage(error)}</Alert>}
						{connection.tools.length > 8 && (
							<label className="focus-ring-within flex items-center gap-[9px] rounded-xl bg-chip px-3">
								<Search aria-hidden size={15} className="shrink-0 text-muted-foreground" />
								<input
									type="search"
									value={query}
									onChange={(event) => setQuery(event.target.value)}
									placeholder={`Search ${connection.tools.length} tools`}
									aria-label="Search tools"
									className="min-w-0 flex-1 bg-transparent py-[9px] text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
								/>
							</label>
						)}
						{connection.tools.length === 0 ? (
							<SettingsGroup label="Tools">
								<SettingsRow label="No actions found yet. Check the connection to see what it can do." />
							</SettingsGroup>
						) : (
							toolGroups(connection)
								.map((group) => ({ ...group, tools: group.tools.filter(matches) }))
								.filter((group) => group.tools.length > 0)
								.map((group) => (
									<SettingsGroup key={group.label} label={group.label} note={group.note}>
										{group.tools.map((tool) => (
											<ConnectionToolRow key={tool.name} tool={tool} />
										))}
									</SettingsGroup>
								))
						)}
						{canManage && (
							<SettingsDanger onClick={() => setRemoving(true)}>Remove connection</SettingsDanger>
						)}
					</div>
				</DialogFormBody>
				<DialogFormFooter action="Done" cancel={false} />
			</DialogFormStep>
			<DeleteDialog
				open={removing}
				onOpenChange={setRemoving}
				title={`Remove ${connection.name}?`}
				description="Bots in this pod can no longer use its tools. Adding it again means signing in or entering its details again."
				confirmLabel="Remove"
				pending={actions.remove.isPending}
				error={actions.remove.error ? failureMessage(actions.remove.error) : undefined}
				onDelete={async () => {
					try {
						await actions.remove.mutateAsync({ connectionId: connection.id });
					} catch {
						return;
					}
					setRemoving(false);
					done();
				}}
			/>
		</DialogFormFrame>
	);
}

const signInMethodNote: Record<SignInMethod, string> = {
	token: "Paste the access token or API key the server gave you.",
	oauth: "You'll sign in to the server next.",
	header: "The secret is sent in this header exactly as you type it.",
};

/** The docs on fixing a connection whose check failed. */
const TROUBLESHOOTING_URL = "https://sugabots.ai/docs/connections#troubleshooting";

type Choice = ConnectionPreset | "custom";

/** Adding a connection: which app, then its sign-in or address and one approval control. */
function AddConnectionDialog({
	podId,
	podName,
	available,
	done,
}: {
	podId: string;
	podName: string;
	available: readonly ConnectionPreset[];
	done: () => void;
}) {
	const [choice, setChoice] = useState<Choice>();
	return (
		<DialogFormFrame>
			{choice === "custom" ? (
				<ByUrlStep podId={podId} onBack={() => setChoice(undefined)} done={done} />
			) : choice ? (
				<AppStep podId={podId} preset={choice} onBack={() => setChoice(undefined)} />
			) : (
				<AppList podName={podName} available={available} onChoose={setChoice} done={done} />
			)}
		</DialogFormFrame>
	);
}

function AppList({
	podName,
	available,
	onChoose,
	done,
}: {
	podName: string;
	available: readonly ConnectionPreset[];
	onChoose: (choice: Choice) => void;
	done: () => void;
}) {
	const [query, setQuery] = useState("");
	const needle = useDeferredValue(query.trim().toLowerCase());
	const shown = available.filter(
		(preset) =>
			needle === "" ||
			preset.name.toLowerCase().includes(needle) ||
			preset.description.toLowerCase().includes(needle),
	);
	return (
		<DialogFormStep onSubmit={(event) => event.preventDefault()}>
			<DialogFormHeader title={`Add to ${podName}`} />
			<DialogFormBody>
				<label className="focus-ring-within flex items-center gap-[9px] rounded-xl bg-chip px-3">
					<Search aria-hidden size={15} className="shrink-0 text-muted-foreground" />
					<input
						type="search"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search apps"
						aria-label="Search apps"
						className="min-w-0 flex-1 bg-transparent py-[9px] text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
					/>
				</label>
				<div className="-mx-1 flex max-h-[min(480px,60vh)] flex-col gap-5 overflow-y-auto px-1">
					{shown.length > 0 && (
						<SettingsGroup>
							{shown.map((preset) => (
								<SettingsRow
									key={preset.id}
									icon={<ConnectionMark presetId={preset.id} name={preset.name} size="tile" />}
									label={preset.name}
									sub={preset.description}
									chevron
									onClick={() => onChoose(preset)}
								/>
							))}
						</SettingsGroup>
					)}
					{shown.length === 0 && needle !== "" && (
						<p className="m-0 px-1 text-muted-foreground text-sm">
							No app matches “{query.trim()}”.
						</p>
					)}
					<SettingsGroup label="Something else">
						<SettingsRow
							icon={
								<SettingsRowIcon className="size-[34px] rounded-[10px]">
									<Code size={15} strokeWidth={2.2} />
								</SettingsRowIcon>
							}
							label="Connect by URL"
							sub="Any MCP server, by its address"
							chevron
							onClick={() => onChoose("custom")}
						/>
					</SettingsGroup>
				</div>
			</DialogFormBody>
			<DialogFormFooter onCancel={done} />
		</DialogFormStep>
	);
}

/**
 * A catalog app: what it is, and whether its bots ask first. Connecting makes
 * it and leaves for its sign-in, which brings the browser back to this pod.
 * Off is not offered here: an app is added to be used, and finishing its
 * sign-in switches an Off one on.
 */
function AppStep({
	podId,
	preset,
	onBack,
}: {
	podId: string;
	preset: ConnectionPreset;
	onBack: () => void;
}) {
	const actions = useConnectionActions(podId);
	const [access, setAccess] = useState<"allow" | "ask">("ask");

	async function submit(event: FormEvent) {
		event.preventDefault();
		try {
			await actions.connect.mutateAsync({ name: preset.name, url: preset.url, access });
		} catch {
			return;
		}
	}

	return (
		<DialogFormStep onSubmit={submit}>
			<DialogFormHeader
				title={preset.name}
				onBack={onBack}
				backDisabled={actions.connect.isPending}
			/>
			<DialogFormBody>
				<div className="flex flex-col items-center gap-1.5 pb-1 text-center">
					<ConnectionMark presetId={preset.id} name={preset.name} />
					<span className="text-[13.5px] text-muted-foreground">{preset.description}</span>
				</div>
				<SettingsGroup>
					<SettingsRow
						label="Approval"
						trailing={
							<SegmentedControl
								label={`What bots may do with ${preset.name}`}
								options={addingOptions}
								value={access}
								onChange={setAccess}
							/>
						}
					/>
				</SettingsGroup>
				{actions.connect.error && <Alert>{failureMessage(actions.connect.error)}</Alert>}
				<Button
					type="submit"
					size="lg"
					className="mt-2 w-full"
					disabled={actions.connect.isPending}
				>
					Connect {preset.name}
					<ArrowUpRight aria-hidden />
				</Button>
				<p className="m-0 text-center text-[12.5px] text-subtle-foreground">
					You'll sign in to {preset.name} next.
				</p>
			</DialogFormBody>
		</DialogFormStep>
	);
}

type SignInMethod = "token" | "oauth" | "header";

const signInMethodOptions: { value: SignInMethod; label: string }[] = [
	{ value: "token", label: "Token" },
	{ value: "oauth", label: "Sign in" },
	{ value: "header", label: "Header" },
];

/**
 * ByUrlStep adds any other MCP server by its address, signing in with an access
 * token, the server's own OAuth sign-in, or a secret in a custom header.
 */
function ByUrlStep({
	podId,
	onBack,
	done,
}: {
	podId: string;
	onBack: () => void;
	done: () => void;
}) {
	const actions = useConnectionActions(podId);
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [method, setMethod] = useState<SignInMethod>("token");
	const [secretHeader, setSecretHeader] = useState("");
	const [secret, setSecret] = useState("");
	const [access, setAccess] = useState<ConnectionAccess>("ask");
	const ready = name.trim() !== "" && url.trim() !== "";
	const pending = actions.create.isPending || actions.update.isPending || actions.connect.isPending;

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!ready) return;
		try {
			if (method === "oauth") {
				await actions.connect.mutateAsync({ name, url, access: access === "off" ? "ask" : access });
				return;
			}
			const made = await actions.create.mutateAsync(
				method === "token"
					? secret.trim()
						? { name, url, secretHeader: "Authorization", secret: bearerAuthorization(secret) }
						: { name, url }
					: { name, url, ...(secretHeader ? { secretHeader } : {}), ...(secret ? { secret } : {}) },
			);
			// A server added by its address starts at Allow.
			if (access !== "allow") {
				await actions.update.mutateAsync({ connectionId: made.id, json: { access } });
			}
		} catch {
			return;
		}
		done();
	}

	const error = actions.create.error ?? actions.update.error ?? actions.connect.error;
	return (
		<DialogFormStep onSubmit={submit}>
			<DialogFormHeader title="Connect by URL" onBack={onBack} backDisabled={pending} />
			<DialogFormBody>
				<SettingsGroup>
					<SettingsFieldRow
						label="Name"
						value={name}
						onChange={setName}
						placeholder="e.g. Team wiki"
					/>
					<SettingsFieldRow
						label="Address"
						value={url}
						onChange={setUrl}
						placeholder="https://mcp.example.com/mcp"
						mono
					/>
				</SettingsGroup>
				<SettingsGroup note={signInMethodNote[method]}>
					<SettingsRow
						label="Sign in with"
						trailing={
							<SegmentedControl
								label="How to sign in to the server"
								options={signInMethodOptions}
								value={method}
								onChange={setMethod}
							/>
						}
					/>
					{method === "token" && (
						<SettingsFieldRow
							label="Access token"
							value={secret}
							onChange={setSecret}
							placeholder="Optional"
							mono
							secret
						/>
					)}
					{method === "header" && (
						<>
							<SettingsFieldRow
								label="Header name"
								value={secretHeader}
								onChange={setSecretHeader}
								placeholder="X-API-Key"
								mono
							/>
							<SettingsFieldRow
								label="Secret"
								value={secret}
								onChange={setSecret}
								placeholder="Optional"
								mono
								secret
							/>
						</>
					)}
				</SettingsGroup>
				<SettingsGroup>
					<SettingsRow
						label="Approval"
						trailing={
							<SegmentedControl
								label="What bots may do with it"
								options={method === "oauth" ? addingOptions : accessOptions}
								value={method === "oauth" && access === "off" ? "ask" : access}
								onChange={setAccess}
							/>
						}
					/>
				</SettingsGroup>
				{error && <Alert>{failureMessage(error)}</Alert>}
			</DialogFormBody>
			<DialogFormFooter
				action={method === "oauth" ? "Sign in" : "Add"}
				actionDisabled={!ready || pending}
				cancel={false}
			/>
		</DialogFormStep>
	);
}
