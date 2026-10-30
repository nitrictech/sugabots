import {
	type Connection,
	type ConnectionAccess,
	type ConnectionToolSetting,
	connectionMarkFor,
	connectionPresetFor,
	connectionToolMutating,
	type Pod,
} from "@sugabots/contracts";
import { projectLinks } from "@sugabots/contracts/project-links";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { Search } from "lucide-react";
import { type FormEvent, type ReactNode, useDeferredValue, useId, useState } from "react";
import {
	bearerAuthorization,
	useConnectionActions,
	useConnectionWithTools,
} from "@/lib/connections.ts";
import { failureMessage } from "@/lib/failure.ts";
import { useInstallGitHubApp } from "@/lib/github-connections.ts";
import { podSettingsPageLink } from "@/lib/links.ts";
import { wordsFromKey } from "@/lib/tool-names.ts";
import { useWorkspace, useWorkspaceMembers } from "@/lib/workspace.ts";
import { Alert } from "@/ui/alert.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { Button } from "@/ui/button.tsx";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import {
	PageBackLink,
	SETTINGS_CARD,
	SettingsDanger,
	SettingsGroup,
	SettingsPage,
	SettingsRow,
	SettingsRowButton,
	SettingsTestOutcome,
	SettingsValue,
} from "@/ui/settings-page.tsx";
import { GitHubRepositoriesGroup } from "./GitHubConnect.tsx";
import { ACCESS_WORDS, AccessToggle } from "./tool-access.tsx";

/*
 * One connection, on a page of its own under its pod: who connected it and
 * what keeps it working (signing in again, its secret, a check that it
 * answers), then its tools as two settings, one for those that only read and
 * one for those that make changes, with any tool set apart from its group on
 * a page of its own, and Disconnect at the foot.
 */

/** The docs on fixing a connection whose check failed. */
const TROUBLESHOOTING_URL = `${projectLinks.documentation}/connections#troubleshooting`;

export function ConnectionPage({
	connection,
	pod,
	back,
}: {
	connection: Connection;
	pod: Pod;
	/** The link back to the pod's connections, or to wherever the page was opened from: a `PageBackLink`. */
	back: ReactNode;
}) {
	const [page, setPage] = useState<"connection" | "tools">("connection");
	const canManage = pod.permissions.manageConnections;
	const actions = useConnectionActions(pod.id);
	const detail = useConnectionWithTools(pod.id, connection.id);
	const setToolAccess = (toolAccess: Record<string, ConnectionAccess>) =>
		actions.update.mutate({ connectionId: connection.id, json: { toolAccess } });

	if (page === "tools" && detail.data) {
		return (
			<IndividualTools
				connection={connection}
				tools={detail.data.tools}
				canManage={canManage}
				setToolAccess={setToolAccess}
				error={actions.update.error}
				back={
					<PageBackLink
						label={connection.name}
						render={<button type="button" onClick={() => setPage("connection")} />}
					/>
				}
			/>
		);
	}
	return (
		<ConnectionCard
			connection={connection}
			pod={pod}
			back={back}
			tools={detail}
			setToolAccess={setToolAccess}
			onOpenTools={() => setPage("tools")}
		/>
	);
}

type ToolsQuery = ReturnType<typeof useConnectionWithTools>;

function ConnectionCard({
	connection,
	pod,
	back,
	tools,
	setToolAccess,
	onOpenTools,
}: {
	connection: Connection;
	pod: Pod;
	back: ReactNode;
	tools: ToolsQuery;
	setToolAccess: (toolAccess: Record<string, ConnectionAccess>) => void;
	onOpenTools: () => void;
}) {
	const canManage = pod.permissions.manageConnections;
	const actions = useConnectionActions(pod.id);
	const installApp = useInstallGitHubApp(pod.id);
	const navigate = useNavigate();
	const [removing, setRemoving] = useState(false);
	const [replacingSecret, setReplacingSecret] = useState(false);
	const preset = connectionPresetFor(connection.url);
	// A GitHub connection works through its app: it has no address to sign in to or check.
	const isServer = connection.kind !== "github";
	const error =
		actions.update.error ?? actions.signIn.error ?? actions.test.error ?? installApp.error;
	const signIn = () => actions.signIn.mutate({ connectionId: connection.id });
	const install = () => installApp.mutate(connection.id);

	async function disconnect() {
		try {
			await actions.remove.mutateAsync({ connectionId: connection.id });
		} catch {
			return;
		}
		setRemoving(false);
		await navigate({ ...podSettingsPageLink(pod, "connections"), replace: true });
	}

	return (
		// Back and the mark as Individual tools has them, so the title stays put between the two.
		<SettingsPage
			back={back}
			backOnWide
			hero={<ConnectionPageMark connection={connection} />}
			title={connection.name}
			description={
				connection.connectedBy ? `Connected by ${connection.connectedBy}` : `In ${pod.name}`
			}
		>
			{error && <Alert>{failureMessage(error)}</Alert>}
			<SettingsGroup
				label={connection.auth === "oauth" || !isServer ? "Account" : "Connection"}
				// A test is a button under the group, with how it went beside it, so it never moves the page.
				note={isServer && <TestConnection connection={connection} podId={pod.id} />}
			>
				{(connection.auth === "oauth" || !isServer) && (
					<SettingsRow
						label={isServer ? "Signed in as" : "Installed by"}
						sub={
							connection.signedIn
								? undefined
								: isServer
									? `Bots can't use ${connection.name} until someone signs in.`
									: "Bots can't use GitHub until the pod's app is installed on the account it works on."
						}
						trailing={
							connection.signedIn ? (
								<span className="flex min-w-0 items-center gap-3">
									<SignedInPerson name={connection.connectedBy} />
									{canManage &&
										(isServer ? (
											connection.auth === "oauth" && (
												<SettingsRowButton disabled={actions.signIn.isPending} onClick={signIn}>
													Reconnect
												</SettingsRowButton>
											)
										) : (
											<SettingsRowButton disabled={installApp.isPending} onClick={install}>
												Manage access
											</SettingsRowButton>
										))}
								</span>
							) : (
								canManage &&
								(isServer ? (
									<SettingsRowButton disabled={actions.signIn.isPending} onClick={signIn}>
										Sign in
									</SettingsRowButton>
								) : (
									<SettingsRowButton disabled={installApp.isPending} onClick={install}>
										Install on GitHub
									</SettingsRowButton>
								))
							)
						}
					/>
				)}
				{/* A catalog app is known by its name; only a server added by URL is told apart by it. */}
				{!preset && isServer && (
					<SettingsRow
						label="Address"
						trailing={
							<span className="min-w-0 truncate font-mono text-[13px] text-muted-foreground">
								{connection.url}
							</span>
						}
					/>
				)}
				{isServer && connection.auth === "header" && (
					<SettingsRow
						label={connection.secretHeader === null ? "Access token" : "Secret"}
						sub={
							connection.secretHeader === null
								? "None yet"
								: `Sent in the ${connection.secretHeader} header`
						}
						trailing={
							canManage && (
								<SettingsRowButton onClick={() => setReplacingSecret(true)}>
									{secretActionLabel(connection)}
								</SettingsRowButton>
							)
						}
					/>
				)}
				{replacingSecret && (
					<SecretForm
						connection={connection}
						podId={pod.id}
						done={() => setReplacingSecret(false)}
					/>
				)}
			</SettingsGroup>
			{connection.kind === "github" && (
				<GitHubRepositoriesGroup
					podId={pod.id}
					connectionId={connection.id}
					appSettingsUrl={connection.appSettingsUrl ?? connection.url}
					canManage={canManage}
				/>
			)}
			<ToolSettings
				tools={tools}
				canManage={canManage}
				setToolAccess={setToolAccess}
				onOpenTools={onOpenTools}
			/>
			{canManage && (
				<SettingsDanger
					label={`Disconnect ${connection.name}`}
					description="Bots in this pod lose access straight away."
					action="Disconnect"
					onClick={() => setRemoving(true)}
				/>
			)}
			<DeleteDialog
				open={removing}
				onOpenChange={setRemoving}
				title={`Disconnect ${connection.name}?`}
				description={
					connection.kind === "github" ? (
						<>
							Bots in this pod can no longer use its tools or its repositories. The pod's app stays
							on GitHub until you delete it there:{" "}
							<a
								href={`${connection.appSettingsUrl ?? connection.url}/advanced`}
								target="_blank"
								rel="noreferrer"
								className="focus-ring rounded-sm font-medium text-link"
							>
								Delete GitHub App
							</a>{" "}
							in its advanced settings.
						</>
					) : (
						"Bots in this pod can no longer use its tools. Connecting it again means signing in or entering its details again."
					)
				}
				confirmLabel="Disconnect"
				pending={actions.remove.isPending}
				error={actions.remove.error ? failureMessage(actions.remove.error) : undefined}
				onDelete={disconnect}
			/>
		</SettingsPage>
	);
}

/**
 * Test connection, with how the last check went beside it rather than under
 * it, so a check never moves the page. A failure says why in a line, with the
 * way to fix it next to that.
 */
function TestConnection({ connection, podId }: { connection: Connection; podId: string }) {
	const actions = useConnectionActions(podId);
	const checked =
		actions.test.variables?.connectionId === connection.id ? actions.test.data : undefined;
	const reachable = checked ? checked.reachable : connection.status === "error" ? false : undefined;
	const failure = checked
		? (checked.error ?? "The server did not answer.")
		: (connection.lastTestError ?? "The last check failed.");
	return (
		<span className="flex min-w-0 items-center gap-3">
			<Button
				variant="secondary"
				size="sm"
				disabled={actions.test.isPending}
				onClick={() => actions.test.mutate({ connectionId: connection.id })}
			>
				Test connection
			</Button>
			{actions.test.isPending ? (
				<span className="text-subtle-foreground">Checking…</span>
			) : reachable === true ? (
				<SettingsTestOutcome good>
					{connection.kind === "http"
						? "The address is allowed. A check sends no request to it."
						: "Connection successful"}
				</SettingsTestOutcome>
			) : reachable === false ? (
				<>
					<SettingsTestOutcome good={false}>{failure}</SettingsTestOutcome>
					<a
						href={TROUBLESHOOTING_URL}
						target="_blank"
						rel="noreferrer"
						className="focus-ring shrink-0 rounded-sm font-medium text-link"
					>
						How to fix this
					</a>
				</>
			) : null}
		</span>
	);
}

/**
 * Whoever signed the connection in, with their face. A connection records
 * only their name, so the face is found among the workspace's people by it,
 * and is their initials when it isn't there.
 */
function SignedInPerson({ name }: { name: string | null }) {
	const { workspace } = useWorkspace();
	const { data: members } = useWorkspaceMembers(workspace?.id);
	if (name === null) return <SettingsValue>Someone no longer here</SettingsValue>;
	const person = members?.find((member) => member.user.name === name)?.user ?? {
		name,
		email: "",
	};
	return (
		<span className="flex min-w-0 items-center gap-2">
			<PersonAvatar person={person} size={20} />
			<SettingsValue>{name}</SettingsValue>
		</span>
	);
}

/** What changing a header connection's secret is called: adding one, or replacing the one it has. */
function secretActionLabel(connection: Connection): string {
	if (connection.secretHeader === null) return "Add access token";
	return connection.hasSecret ? "Replace secret" : "Add secret";
}

/** A new secret for a header connection, or its first access token, in a row of its own group. */
function SecretForm({
	connection,
	podId,
	done,
}: {
	connection: Connection;
	podId: string;
	done: () => void;
}) {
	const actions = useConnectionActions(podId);
	const [secret, setSecret] = useState("");
	const needsToken = connection.secretHeader === null;

	async function save(event: FormEvent) {
		event.preventDefault();
		if (!secret) return;
		try {
			await actions.update.mutateAsync({
				connectionId: connection.id,
				json: needsToken
					? { secretHeader: "Authorization", secret: bearerAuthorization(secret) }
					: { secret },
			});
		} catch {
			return;
		}
		done();
	}

	return (
		<form
			onSubmit={save}
			className="flex min-h-14 items-center gap-3 border-border border-b px-4 py-2.5 last:border-b-0"
		>
			<input
				aria-label={`${connection.name} secret`}
				type="password"
				autoComplete="off"
				// biome-ignore lint/a11y/noAutofocus: opened by asking to change it, so typing is next.
				autoFocus
				value={secret}
				onChange={(event) => setSecret(event.target.value)}
				placeholder={needsToken ? "Paste the access token" : "Paste the new secret"}
				className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-foreground outline-none placeholder:text-subtle-foreground"
			/>
			<Button type="button" size="sm" variant="ghost" onClick={done}>
				Cancel
			</Button>
			<Button type="submit" size="sm" disabled={!secret || actions.update.isPending}>
				Save
			</Button>
		</form>
	);
}

/** A connection's tools in its two kinds, and what each kind is set to before any tool is set apart. */
interface ToolKind {
	kind: "read" | "change";
	tools: ConnectionToolSetting[];
	/** What most of its tools are set to: the group's setting, which a tool set apart differs from. */
	setting: ConnectionAccess;
}

/** Where a kind's setting starts when its tools are split evenly: reads run, changes ask. */
const KIND_LEANING: Record<ToolKind["kind"], ConnectionAccess> = { read: "allow", change: "ask" };

/** The connection's tools that only read, then those that may make changes, leaving out an empty kind. */
function toolKinds(tools: readonly ConnectionToolSetting[]): ToolKind[] {
	return [
		{ kind: "read" as const, tools: tools.filter((tool) => !connectionToolMutating(tool)) },
		{ kind: "change" as const, tools: tools.filter(connectionToolMutating) },
	].flatMap(({ kind, tools: ofKind }) =>
		ofKind.length === 0 ? [] : [{ kind, tools: ofKind, setting: settingOf(ofKind, kind) }],
	);
}

/** The access most of `tools` have, leaning as the kind does when two are tied. */
function settingOf(tools: readonly ConnectionToolSetting[], kind: ToolKind["kind"]) {
	const count = (access: ConnectionAccess) => tools.filter((tool) => tool.access === access).length;
	const leaning = KIND_LEANING[kind];
	return (["allow", "ask", "off"] as const).reduce<ConnectionAccess>(
		(best, access) => (count(access) > count(best) ? access : best),
		leaning,
	);
}

/** The tools of `kinds` set apart from their kind's setting. */
function setApart(kinds: readonly ToolKind[]) {
	return kinds.flatMap(({ tools, setting }) =>
		tools.filter((tool) => tool.access !== setting).map((tool) => ({ tool, setting })),
	);
}

/** How many of a kind's tools show before its list scrolls inside its card rather than lengthening the page. */
const TOOLS_SHOWN_BEFORE_SCROLLING = 8;

const KIND_WORDS = {
	read: {
		heading: "Tools that read",
		all: (count: number) => `All ${count} read ${count === 1 ? "tool" : "tools"}`,
		sub: "Look things up without changing anything",
	},
	change: {
		heading: "Tools that make changes",
		all: (count: number) => `All ${count} change ${count === 1 ? "tool" : "tools"}`,
		sub: "Create, edit, delete or send things",
	},
} as const;

/**
 * Each kind's setting, which moves every tool still at it and leaves those set
 * apart as they are, then the way to the tools set apart. The tools are
 * fetched on their own because a server can list hundreds.
 */
function ToolSettings({
	tools,
	canManage,
	setToolAccess,
	onOpenTools,
}: {
	tools: ToolsQuery;
	canManage: boolean;
	setToolAccess: (toolAccess: Record<string, ConnectionAccess>) => void;
	onOpenTools: () => void;
}) {
	if (tools.isPending) {
		return (
			<div role="status" aria-label="Loading tools" className="flex flex-col gap-3">
				<div className="h-[92px] animate-pulse rounded-xl border border-settings-card-border bg-settings-card" />
				<div className="h-[92px] animate-pulse rounded-xl border border-settings-card-border bg-settings-card" />
			</div>
		);
	}
	if (tools.isError) return <Alert>{failureMessage(tools.error)}</Alert>;
	const kinds = toolKinds(tools.data.tools);
	if (kinds.length === 0) {
		return (
			<SettingsGroup label="Tools">
				<SettingsRow label={<span className="text-muted-foreground">No actions found yet</span>} />
			</SettingsGroup>
		);
	}
	const apart = setApart(kinds).length;
	return (
		<>
			{kinds.map(({ kind, tools: ofKind, setting }) => {
				const words = KIND_WORDS[kind];
				return (
					<SettingsGroup
						key={kind}
						label={words.heading}
						note={
							kind === "change"
								? "Ask first sends the action to Approvals before it runs."
								: undefined
						}
					>
						<SettingsRow
							label={words.all(ofKind.length)}
							sub={words.sub}
							trailing={
								<AccessToggle
									label={words.heading}
									value={setting}
									canManage={canManage}
									onChange={(access) =>
										setToolAccess(
											Object.fromEntries(
												ofKind
													.filter((tool) => tool.access === setting)
													.map((tool) => [tool.name, access]),
											),
										)
									}
								/>
							}
						/>
					</SettingsGroup>
				);
			})}
			<SettingsGroup>
				<SettingsRow
					label="Individual tools"
					sub={
						canManage
							? "Set one tool differently from its group"
							: "Tools set apart from their group"
					}
					trailing={apart > 0 && <SettingsValue>{apart} changed</SettingsValue>}
					chevron
					onClick={onOpenTools}
				/>
			</SettingsGroup>
		</>
	);
}

/**
 * A section of the Individual tools list: its heading, what its tools have in
 * common, and an action beside them, held at the top of the list while its
 * tools scroll under it.
 */
function ToolSection({
	heading,
	description,
	action,
	children,
}: {
	heading: string;
	description: string;
	action?: ReactNode;
	children: ReactNode;
}) {
	const headingId = useId();
	return (
		<section aria-labelledby={headingId}>
			<div className="sticky top-0 z-10 flex items-center gap-3 border-border border-b bg-chip px-4 py-2.5">
				<div className="flex min-w-0 flex-1 flex-col gap-0.5 leading-[1.35]">
					<h3 id={headingId} className="m-0 font-medium text-[13px] text-foreground">
						{heading}
					</h3>
					<span className="text-pretty text-subtle-foreground text-xs">{description}</span>
				</div>
				{action}
			</div>
			{children}
		</section>
	);
}

/**
 * Every tool on a page of its own: those set apart from their kind first, each
 * saying what its kind is set to, with the way to put them all back; then the
 * rest by kind. Searching narrows all of them.
 */
/** The connection's mark at the head of its pages. */
function ConnectionPageMark({ connection }: { connection: Connection }) {
	return (
		<ConnectionMark presetId={connectionMarkFor(connection)} name={connection.name} size="lg" />
	);
}

function IndividualTools({
	connection,
	tools,
	canManage,
	setToolAccess,
	error,
	back,
}: {
	connection: Connection;
	tools: readonly ConnectionToolSetting[];
	canManage: boolean;
	setToolAccess: (toolAccess: Record<string, ConnectionAccess>) => void;
	error: unknown;
	back: ReactNode;
}) {
	const [query, setQuery] = useState("");
	const needle = useDeferredValue(query.trim().toLowerCase());
	const matches = (tool: ConnectionToolSetting) =>
		needle === "" ||
		tool.name.toLowerCase().includes(needle) ||
		wordsFromKey(tool.name).toLowerCase().includes(needle);
	const kinds = toolKinds(tools);
	const apart = setApart(kinds);
	const shownApart = apart.filter(({ tool }) => matches(tool));
	const row = (tool: ConnectionToolSetting, setting: ConnectionAccess, changed: boolean) => (
		<SettingsRow
			key={tool.name}
			// Set in under its section's heading, so the heading reads as one and the tools as its.
			className="pl-9"
			label={
				<span
					className={cn(
						"font-mono",
						// Off fades to a quieter colour, not by opacity, which would take it below a readable contrast.
						tool.access === "off" && "text-muted-foreground",
					)}
				>
					{tool.name}
				</span>
			}
			sub={changed ? `Default: ${ACCESS_WORDS[setting].toLowerCase()}` : undefined}
			trailing={
				<AccessToggle
					label={tool.name}
					value={tool.access}
					canManage={canManage}
					onChange={(access) => setToolAccess({ [tool.name]: access })}
				/>
			}
		/>
	);
	const anyShown = shownApart.length > 0 || kinds.some(({ tools: of }) => of.some(matches));

	return (
		<SettingsPage
			back={back}
			backOnWide
			hero={<ConnectionPageMark connection={connection} />}
			title="Individual tools"
			description={`Set a tool of ${connection.name} differently from its group.`}
		>
			{Boolean(error) && <Alert>{failureMessage(error)}</Alert>}
			{/* One card, searched from its top and read down: a long list scrolls inside it rather than lengthening the page. */}
			<section aria-label="Tools" className={SETTINGS_CARD}>
				{/* Above the list and as solid as the card, so no row shows past the list's top as it scrolls. */}
				<div className="relative z-1 border-border border-b bg-settings-card p-2.5">
					<label className="focus-ring-within flex h-[34px] items-center gap-2 rounded-lg border border-border-strong bg-background px-2.5">
						<Search aria-hidden size={14} className="shrink-0 text-subtle-foreground" />
						<input
							type="search"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={`Search ${tools.length} ${connection.name} tools`}
							aria-label="Search tools"
							className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-subtle-foreground"
						/>
					</label>
				</div>
				{/* Sized by every tool, not those a search leaves, so searching never resizes it. */}
				<div
					className={cn(
						tools.length > TOOLS_SHOWN_BEFORE_SCROLLING &&
							// Relative, so the hidden radios inside are held to it: placed by the page instead, those scrolled out of view would lengthen it.
							"relative h-[min(560px,60vh)] overflow-y-auto [scrollbar-gutter:stable]",
						// Its sticky headings layered within it, under the search and the page's Back.
						"isolate",
						// A phone's scrollbar floats over the list, and pulling past its top would open a gap under the search.
						"max-md:overscroll-none max-md:[scrollbar-gutter:auto]",
					)}
				>
					{shownApart.length > 0 && (
						<ToolSection
							heading={`Changed (${shownApart.length})`}
							description="Set apart from their group."
							action={
								canManage && (
									<SettingsRowButton
										onClick={() =>
											setToolAccess(
												Object.fromEntries(apart.map(({ tool, setting }) => [tool.name, setting])),
											)
										}
									>
										Reset all
									</SettingsRowButton>
								)
							}
						>
							{shownApart.map(({ tool, setting }) => row(tool, setting, true))}
						</ToolSection>
					)}
					{kinds.map(({ kind, tools: ofKind, setting }) => {
						const shown = ofKind.filter((tool) => tool.access === setting && matches(tool));
						if (shown.length === 0) return null;
						return (
							<ToolSection
								key={kind}
								heading={KIND_WORDS[kind].heading}
								description={`Follow the group's setting, ${ACCESS_WORDS[setting]}, until one is set differently.`}
							>
								{shown.map((tool) => row(tool, setting, false))}
							</ToolSection>
						);
					})}
					{!anyShown && (
						<p className="m-0 px-4 py-8 text-center text-[13px] text-subtle-foreground">
							No tools match.
						</p>
					)}
				</div>
			</section>
		</SettingsPage>
	);
}
