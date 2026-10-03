import {
	type Connection,
	type ConnectionPreset,
	connectionCatalog,
	connectionPresetFor,
	type Pod,
	type UnsavedConnection,
} from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { ArrowUpRight, ChevronRight, Code, Search } from "lucide-react";
import { type FormEvent, useDeferredValue, useState } from "react";
import { bearerAuthorization, useConnectionActions, useConnections } from "@/lib/connections.ts";
import { failureMessage } from "@/lib/failure.ts";
import { connectionSettingsLink } from "@/lib/links.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { Alert, Success } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
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
	SettingsRow,
	SettingsRowIcon,
} from "@/ui/settings-page.tsx";
import { AccessMenu, AccessValue, accessSettingOf, accessSummaryText } from "./tool-access.tsx";

/*
 * The apps a pod's bots can reach, as one group on the pod's page: each with
 * what its tools are set to, Allow, Ask or Off for all of them at once, and
 * whatever it needs (a sign-in, a reconnect) on its line. A row opens the
 * connection's own page: its address, each of its tools, and removing it.
 * Adding one is a dialog: the app and its sign-in, or any other server by its
 * address. Each tool the server lists starts at its default.
 */

export function ConnectionsSettings({
	pod,
	canManage,
	signInError,
}: {
	pod: Pod;
	canManage: boolean;
	/** Why the OAuth sign-in that just returned here did not finish, in our own words. */
	signInError?: string;
}) {
	const connections = useConnections(pod.id);
	const [adding, setAdding] = useState(false);
	if (connections.isPending) return null;
	if (connections.isError) return <Alert>{failureMessage(connections.error)}</Alert>;
	const listed = connections.data;
	const taken = new Set(listed.map((one) => connectionPresetFor(one.url)?.id));

	return (
		<>
			{signInError && <Alert>Signing in did not finish: {signInError}</Alert>}
			<SettingsGroup
				label="Connections"
				note="Every bot in this pod can use these. Open one to choose for each tool."
			>
				{listed.map((one) => (
					<ConnectionRow key={one.id} connection={one} pod={pod} canManage={canManage} />
				))}
				{listed.length === 0 && !canManage && <SettingsRow label="No connections in this pod." />}
				{canManage && <SettingsAddRow label="Add connection" onClick={() => setAdding(true)} />}
			</SettingsGroup>
			<Dialog open={adding} onOpenChange={setAdding}>
				{adding && (
					<AddConnectionDialog
						podId={pod.id}
						podName={pod.name}
						available={connectionCatalog.filter((preset) => !taken.has(preset.id))}
						done={() => setAdding(false)}
					/>
				)}
			</Dialog>
		</>
	);
}

/** What a connection's line says under its name: what it needs, or what its tools are set to. */
function lineFor(connection: Connection): string {
	if (!connection.signedIn) return "Not signed in yet";
	if (connection.status === "error") return connection.lastTestError ?? "The last check failed";
	return accessSummaryText(connection.tools) ?? "No actions found yet";
}

function ConnectionRow({
	connection,
	pod,
	canManage,
}: {
	connection: Connection;
	pod: Pod;
	canManage: boolean;
}) {
	const actions = useConnectionActions(pod.id);
	const navigate = useNavigate();
	const backToPod = useBackToHere(pod.name);
	const page = { ...connectionSettingsLink(pod, connection), state: backToPod };
	const preset = connectionPresetFor(connection.url);
	const needsSignIn = !connection.signedIn;
	const failing = connection.signedIn && connection.status === "error";
	const pending = actions.update.isPending || actions.signIn.isPending;
	const error = actions.update.error ?? actions.signIn.error;
	// A failing secret or address is fixed on the connection's own page.
	const reconnect = () =>
		connection.auth === "oauth"
			? actions.signIn.mutate({ connectionId: connection.id })
			: void navigate(page);
	const line = error ? failureMessage(error) : lineFor(connection);
	const access = accessSettingOf(connection.tools);

	return (
		<article
			aria-label={connection.name}
			className="relative flex min-h-[60px] items-center gap-3 border-border border-b px-4 py-2.5 transition-colors last:border-b-0 hover:bg-panel"
		>
			{/* Its link covers the whole row; the controls sit above it. */}
			<Link
				{...page}
				aria-label={`${connection.name}, ${line}. Open tools`}
				className="focus-ring flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left after:absolute after:inset-0"
			>
				<ConnectionMark presetId={preset?.id} name={connection.name} size="tile" />
				<span className="flex min-w-0 flex-1 flex-col gap-px">
					<span className="truncate font-medium text-[14.5px] text-foreground">
						{connection.name}
					</span>
					<span
						className={`text-pretty text-sm ${failing || error ? "line-clamp-2 text-destructive-text" : "text-muted-foreground"}`}
					>
						{line}
					</span>
				</span>
			</Link>
			<span className="relative ml-auto flex shrink-0 items-center gap-2">
				{canManage && (needsSignIn || failing) && (
					<Button size="sm" variant="secondary" disabled={pending} onClick={reconnect}>
						{needsSignIn ? "Sign in" : connection.auth === "oauth" ? "Reconnect" : "Fix"}
					</Button>
				)}
				{/* With no tools found yet, there is nothing to set. On a phone, the setting is opened to change. */}
				{access && canManage && (
					<AccessMenu
						label={`${connection.name}, all tools`}
						value={access}
						onChange={(chosen) =>
							actions.update.mutate({
								connectionId: connection.id,
								json: {
									toolAccess: Object.fromEntries(
										connection.tools.map((tool) => [tool.name, chosen]),
									),
								},
							})
						}
						onCustom={() => void navigate(page)}
						className="max-md:hidden"
					/>
				)}
				{access && <AccessValue value={access} className={cn(canManage && "md:hidden")} />}
			</span>
			<ChevronRight
				aria-hidden
				size={16}
				strokeWidth={2.4}
				className="shrink-0 text-subtle-foreground"
			/>
		</article>
	);
}

const signInMethodNote: Record<SignInMethod, string> = {
	token: "Paste the access token or API key the server gave you.",
	oauth: "You'll sign in to the server next.",
	header: "The secret is sent in this header exactly as you type it.",
};

type Choice = ConnectionPreset | "custom";

/** Adding a connection: which app, then its sign-in, or any other server by its address. */
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
 * A catalog app: what it is. Connecting makes it and leaves for its sign-in,
 * which brings the browser back to this pod.
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

	async function submit(event: FormEvent) {
		event.preventDefault();
		try {
			await actions.connect.mutateAsync({ name: preset.name, url: preset.url });
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
	// What the last Test or Add found. Changing how to reach the server makes it out of date.
	const [outcome, setOutcome] = useState<{ ok: true } | { ok: false; message: string }>();
	const clearingOutcome =
		<T,>(set: (value: T) => void) =>
		(value: T) => {
			set(value);
			setOutcome(undefined);
		};
	const ready = name.trim() !== "" && url.trim() !== "";
	const pending = actions.create.isPending || actions.connect.isPending;
	const server: UnsavedConnection =
		method === "token"
			? {
					url,
					...(secret.trim()
						? { secretHeader: "Authorization", secret: bearerAuthorization(secret) }
						: {}),
				}
			: { url, ...(secretHeader ? { secretHeader } : {}), ...(secret ? { secret } : {}) };

	async function test() {
		try {
			const tested = await actions.testUnsaved.mutateAsync(server);
			setOutcome(
				tested.reachable
					? { ok: true }
					: { ok: false, message: tested.error ?? "The server did not answer." },
			);
		} catch (failure) {
			setOutcome({ ok: false, message: failureMessage(failure) });
		}
	}

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!ready) return;
		try {
			if (method === "oauth") {
				await actions.connect.mutateAsync({ name, url });
				return;
			}
			await actions.create.mutateAsync({ name, ...server });
		} catch (failure) {
			setOutcome({ ok: false, message: failureMessage(failure) });
			return;
		}
		done();
	}

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
						onChange={clearingOutcome(setUrl)}
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
								onChange={clearingOutcome(setMethod)}
							/>
						}
					/>
					{method === "token" && (
						<SettingsFieldRow
							label="Access token"
							value={secret}
							onChange={clearingOutcome(setSecret)}
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
								onChange={clearingOutcome(setSecretHeader)}
								placeholder="X-API-Key"
								mono
							/>
							<SettingsFieldRow
								label="Secret"
								value={secret}
								onChange={clearingOutcome(setSecret)}
								placeholder="Optional"
								mono
								secret
							/>
						</>
					)}
				</SettingsGroup>
				{outcome &&
					(outcome.ok ? (
						<Success>Connection successful</Success>
					) : (
						<Alert>{outcome.message}</Alert>
					))}
			</DialogFormBody>
			<DialogFormFooter
				beside={
					method !== "oauth" && (
						<Button
							type="button"
							variant="secondary"
							disabled={url.trim() === "" || actions.testUnsaved.isPending}
							onClick={() => void test()}
						>
							{actions.testUnsaved.isPending ? "Testing…" : "Test"}
						</Button>
					)
				}
				action={method === "oauth" ? "Sign in" : "Add"}
				actionDisabled={!ready || pending}
				cancel={false}
			/>
		</DialogFormStep>
	);
}
