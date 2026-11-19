import {
	type Connection,
	type ConnectionPreset,
	connectionCatalog,
	connectionMarkFor,
	connectionPresetFor,
	type UnsavedConnection,
} from "@sugabots/contracts";
import { cn } from "cn";
import { ArrowUpRight, ChevronRight, Code, Globe } from "lucide-react";
import { type FormEvent, useState } from "react";
import { bearerAuthorization, useConnectionActions, useConnections } from "@/lib/connections.ts";
import { failureMessage } from "@/lib/failure.ts";
import {
	OwnerLink,
	ownerName,
	type ResourceOwner,
	resourceProjectId,
	useNavigateToOwnerPage,
} from "@/lib/resource-owner.tsx";
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
import { SearchField, useSearchFilter } from "@/ui/search-field.tsx";
import { SegmentedControl } from "@/ui/segmented-control.tsx";
import {
	SettingsFieldRow,
	SettingsGroup,
	SettingsRow,
	SettingsRowIcon,
} from "@/ui/settings-page.tsx";
import { GitHubConnectStep } from "./GitHubConnect.tsx";
import { accessSummaryText } from "./tool-access.tsx";

/*
 * The services a project's bots can reach, as one group on its Connections
 * page, a bot's being its default project's: each with
 * what its tools are set to, Allow, Ask or Off for all of them at once, and
 * whatever it needs (a sign-in, a reconnect) on its line. A row opens the
 * connection's own page: its address, each of its tools, and removing it.
 * Adding one is a dialog: the app and its sign-in, or any other server or HTTP
 * endpoint by its address. Each tool the server lists starts at its default.
 */

export function ConnectionsSettings({
	owner,
	canManage,
	signInError,
	adding,
	onAddingChange,
}: {
	/** The bot or project whose connections these are. */
	owner: ResourceOwner;
	canManage: boolean;
	/** Why the OAuth sign-in that just returned here did not finish, in our own words. */
	signInError?: string;
	/** Whether Add connection is open, which the page's own button beside its title opens. */
	adding: boolean;
	onAddingChange: (adding: boolean) => void;
}) {
	const projectId = resourceProjectId(owner);
	const connections = useConnections(projectId);
	if (connections.isPending) return null;
	if (connections.isError) return <Alert>{failureMessage(connections.error)}</Alert>;
	const listed = connections.data;
	const taken = new Set(listed.map((one) => connectionPresetFor(one.url)?.id));

	return (
		<>
			{signInError && <Alert>Signing in did not finish: {signInError}</Alert>}
			<SettingsGroup note="Bots act as whoever connected each one. Open one to choose for each tool.">
				{listed.map((one) => (
					<ConnectionRow key={one.id} connection={one} owner={owner} canManage={canManage} />
				))}
				{listed.length === 0 && (
					<SettingsRow label={<span className="text-muted-foreground">No connections yet</span>} />
				)}
			</SettingsGroup>
			{canManage && (
				<Dialog open={adding} onOpenChange={onAddingChange}>
					{adding && (
						<AddConnectionDialog
							projectId={projectId}
							addingTo={ownerName(owner)}
							available={connectionCatalog.filter((preset) => !taken.has(preset.id))}
							offersGitHub={!listed.some((one) => one.kind === "github")}
							done={() => onAddingChange(false)}
						/>
					)}
				</Dialog>
			)}
		</>
	);
}

/** What a connection's line says under its name: what it needs, or what its tools are set to. */
function lineFor(connection: Connection): string {
	if (connection.signInExpired)
		return "Sign-in expired. Bots can't use it until someone signs in again";
	if (!connection.signedIn) return "Not signed in yet";
	if (connection.status === "error") return connection.lastTestError ?? "The last check failed";
	return accessSummaryText(connection.toolCounts) ?? "No actions found yet";
}

function ConnectionRow({
	connection,
	owner,
	canManage,
}: {
	connection: Connection;
	owner: ResourceOwner;
	canManage: boolean;
}) {
	const actions = useConnectionActions(resourceProjectId(owner));
	const navigateToOwnerPage = useNavigateToOwnerPage();
	const page = { page: "connection", connectionId: connection.id } as const;
	const needsSignIn = !connection.signedIn;
	const failing =
		connection.signInExpired || (connection.signedIn && connection.status === "error");
	const pending = actions.update.isPending || actions.signIn.isPending;
	const error = actions.update.error ?? actions.signIn.error;
	// A failing secret or address is fixed on the connection's own page.
	const reconnect = () =>
		connection.auth === "oauth"
			? actions.signIn.mutate({ connectionId: connection.id })
			: void navigateToOwnerPage(owner, page);
	const line = error ? failureMessage(error) : lineFor(connection);

	return (
		<article
			aria-label={connection.name}
			className="relative flex min-h-14 items-center gap-3.5 border-border border-b px-4 py-3 transition-colors last:border-b-0 hover:bg-settings-row-hover active:bg-row-selected"
		>
			{/* Its link covers the whole row; the controls sit above it. */}
			<OwnerLink
				owner={owner}
				to={page}
				aria-label={`${connection.name}, ${line}. Open tools`}
				className="focus-ring flex min-w-0 flex-1 items-center gap-3.5 rounded-lg text-left after:absolute after:inset-0"
			>
				<ConnectionMark
					presetId={connectionMarkFor(connection)}
					name={connection.name}
					size="tile"
				/>
				<span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-snug">
					<span className="truncate text-sm text-foreground">{connection.name}</span>
					<span
						className={cn(
							"text-pretty text-xs",
							failing || error ? "line-clamp-2 text-destructive-text" : "text-subtle-foreground",
						)}
					>
						{line}
					</span>
				</span>
			</OwnerLink>
			<span className="relative ml-auto flex shrink-0 items-center gap-2">
				{canManage && (needsSignIn || failing) && (
					<Button size="sm" variant="secondary" disabled={pending} onClick={reconnect}>
						{connection.signInExpired
							? "Sign in again"
							: needsSignIn
								? "Sign in"
								: connection.auth === "oauth"
									? "Reconnect"
									: "Fix"}
					</Button>
				)}
			</span>
			<ChevronRight
				aria-hidden
				size={14}
				strokeWidth={2}
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

type Choice = ConnectionPreset | "custom" | "http" | "github";

/** Adding a connection: which app, then its sign-in, or any other server by its address. */
function AddConnectionDialog({
	projectId,
	addingTo,
	available,
	offersGitHub,
	done,
}: {
	projectId: string;
	/** Who the connection is added to: the bot or project, by name. */
	addingTo: string;
	available: readonly ConnectionPreset[];
	/** Whether it may connect to GitHub, which a project, so a bot, may only once. */
	offersGitHub: boolean;
	done: () => void;
}) {
	const [choice, setChoice] = useState<Choice>();
	return (
		<DialogFormFrame>
			{choice === "github" ? (
				<GitHubConnectStep projectId={projectId} onBack={() => setChoice(undefined)} done={done} />
			) : choice === "custom" || choice === "http" ? (
				<ByUrlStep
					projectId={projectId}
					kind={choice === "http" ? "http" : "mcp"}
					onBack={() => setChoice(undefined)}
					done={done}
				/>
			) : choice ? (
				<AppStep projectId={projectId} preset={choice} onBack={() => setChoice(undefined)} />
			) : (
				<AppList
					addingTo={addingTo}
					available={available}
					offersGitHub={offersGitHub}
					onChoose={setChoice}
					done={done}
				/>
			)}
		</DialogFormFrame>
	);
}

/** GitHub as the app list shows it, beside the catalog's MCP apps; it connects through an app of the project's own. */
const GITHUB_APP = {
	choice: "github",
	id: "github",
	name: "GitHub",
	description: "Repositories, issues and pull requests",
} as const;

function AppList({
	addingTo,
	available,
	offersGitHub,
	onChoose,
	done,
}: {
	/** Who the connection is added to: the bot or project, by name. */
	addingTo: string;
	available: readonly ConnectionPreset[];
	offersGitHub: boolean;
	onChoose: (choice: Choice) => void;
	done: () => void;
}) {
	const apps = [
		...(offersGitHub ? [GITHUB_APP] : []),
		...available.map((preset) => ({ ...preset, choice: preset })),
	];
	const { query, setQuery, searching, matches } = useSearchFilter(apps, (app) => [
		app.name,
		app.description,
	]);
	return (
		<DialogFormStep onSubmit={(event) => event.preventDefault()}>
			<DialogFormHeader title={`Add to ${addingTo}`} />
			<DialogFormBody>
				<SearchField label="Search apps" value={query} onChange={setQuery} />
				<div className="-mx-1 flex max-h-picker flex-col gap-5 overflow-y-auto px-1 max-md:max-h-none max-md:overflow-visible">
					{matches.length > 0 && (
						<SettingsGroup>
							{matches.map((app) => (
								<SettingsRow
									key={app.id}
									icon={<ConnectionMark presetId={app.id} name={app.name} size="tile" />}
									label={app.name}
									sub={app.description}
									chevron
									onClick={() => onChoose(app.choice)}
								/>
							))}
						</SettingsGroup>
					)}
					{matches.length === 0 && searching && (
						<p className="m-0 px-1 text-muted-foreground text-xs">
							No app matches “{query.trim()}”.
						</p>
					)}
					<SettingsGroup label="Something else">
						<SettingsRow
							icon={
								<SettingsRowIcon className="size-8.5 rounded-lg">
									<Code size={15} strokeWidth={2.2} />
								</SettingsRowIcon>
							}
							label="Connect by URL"
							sub="Any MCP server, by its address"
							chevron
							onClick={() => onChoose("custom")}
						/>
						<SettingsRow
							icon={
								<SettingsRowIcon className="size-8.5 rounded-lg">
									<Globe size={15} strokeWidth={2.2} />
								</SettingsRowIcon>
							}
							label="HTTP endpoint"
							sub="Any web API, by its base address"
							chevron
							onClick={() => onChoose("http")}
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
 * which brings the browser back to these connections.
 */
function AppStep({
	projectId,
	preset,
	onBack,
}: {
	projectId: string;
	preset: ConnectionPreset;
	onBack: () => void;
}) {
	const actions = useConnectionActions(projectId);

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
					<span className="text-xs text-muted-foreground">{preset.description}</span>
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
				<p className="m-0 text-center text-xs text-subtle-foreground">
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
 * token, the server's own OAuth sign-in, or a secret in a custom header. An
 * HTTP endpoint takes a token or a header, or neither, and has nothing to
 * test before it is added: its check sends no request.
 */
function ByUrlStep({
	projectId,
	kind,
	onBack,
	done,
}: {
	projectId: string;
	kind: "mcp" | "http";
	onBack: () => void;
	done: () => void;
}) {
	const isEndpoint = kind === "http";
	const actions = useConnectionActions(projectId);
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
			await actions.create.mutateAsync({ kind, name, ...server });
		} catch (failure) {
			setOutcome({ ok: false, message: failureMessage(failure) });
			return;
		}
		done();
	}

	return (
		<DialogFormStep onSubmit={submit}>
			<DialogFormHeader
				title={isEndpoint ? "HTTP endpoint" : "Connect by URL"}
				onBack={onBack}
				backDisabled={pending}
			/>
			<DialogFormBody>
				<SettingsGroup
					note={
						isEndpoint
							? "Bots can send GET, POST, PUT, PATCH and DELETE requests to paths under this address. They never see the secret."
							: undefined
					}
				>
					<SettingsFieldRow
						label="Name"
						value={name}
						onChange={setName}
						placeholder="e.g. Team wiki"
					/>
					<SettingsFieldRow
						label="Server URL"
						value={url}
						onChange={clearingOutcome(setUrl)}
						placeholder={isEndpoint ? "https://api.example.com/v1" : "https://mcp.example.com/mcp"}
						mono
					/>
				</SettingsGroup>
				<SettingsGroup note={signInMethodNote[method]}>
					<SettingsRow
						label="Sign in with"
						trailing={
							<SegmentedControl
								label="How to sign in to the server"
								options={
									isEndpoint
										? signInMethodOptions.filter((option) => option.value !== "oauth")
										: signInMethodOptions
								}
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
					method !== "oauth" &&
					!isEndpoint && (
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
