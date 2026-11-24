import {
	builtInConnectorFor,
	type Connector,
	type ConnectorAccess,
	type ConnectorToolSetting,
	connectorMarkFor,
	connectorToolWritesOrDeletes,
	type NamedMember,
} from "@sugabots/contracts";
import { projectLinks } from "@sugabots/contracts/project-links";
import { cn } from "cn";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import {
	bearerAuthorization,
	useConnectorActions,
	useConnectorWithTools,
} from "@/lib/connectors.ts";
import { failureMessage } from "@/lib/failure.ts";
import { useInstallGitHubApp } from "@/lib/github-connectors.ts";
import { countOf } from "@/lib/name-list.ts";
import {
	ownerName,
	type ResourceOwner,
	resourcePermissions,
	resourceProjectId,
	useNavigateToOwnerPage,
} from "@/lib/resource-owner.tsx";
import { TOOL_ACCESS_LABELS } from "@/lib/tool-access-labels.ts";
import { wordsFromKey } from "@/lib/tool-names.ts";
import { Alert } from "@/ui/alert.tsx";
import { MemberAvatar } from "@/ui/avatar.tsx";
import { Button } from "@/ui/button.tsx";
import { ConnectorMark } from "@/ui/connector-mark.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { SearchField, useSearchFilter } from "@/ui/search-field.tsx";
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
import { AccessToggle } from "./tool-access.tsx";

/*
 * One connector, on a page of its own under its bot or project: who connected it and
 * what keeps it working (signing in again, its secret, a check that it
 * answers), then its tools as two settings, one for those that only read and
 * one for those that make changes, with any tool set apart from its group on
 * a page of its own, and Disconnect at the foot.
 */

/** The docs on fixing a connector whose check failed. */
const TROUBLESHOOTING_URL = `${projectLinks.documentation}/connectors#troubleshooting`;

export function ConnectorPage({
	connector,
	owner,
}: {
	connector: Connector;
	/** The bot or project the connector is of. */
	owner: ResourceOwner;
}) {
	const [page, setPage] = useState<"connector" | "tools">("connector");
	const canManage = resourcePermissions(owner).manageConnectors;
	const projectId = resourceProjectId(owner);
	const actions = useConnectorActions(projectId);
	const detail = useConnectorWithTools(projectId, connector.id);
	const setToolAccess = (toolAccess: Record<string, ConnectorAccess>) =>
		actions.update.mutate({ connectorId: connector.id, json: { toolAccess } });

	if (page === "tools" && detail.data) {
		return (
			<IndividualTools
				connector={connector}
				tools={detail.data.tools}
				canManage={canManage}
				setToolAccess={setToolAccess}
				error={actions.update.error}
				back={
					<PageBackLink
						label={connector.name}
						render={<button type="button" onClick={() => setPage("connector")} />}
					/>
				}
			/>
		);
	}
	return (
		<ConnectorCard
			connector={connector}
			owner={owner}
			tools={detail}
			setToolAccess={setToolAccess}
			onOpenTools={() => setPage("tools")}
		/>
	);
}

type ToolsQuery = ReturnType<typeof useConnectorWithTools>;

function ConnectorCard({
	connector,
	owner,
	tools,
	setToolAccess,
	onOpenTools,
}: {
	connector: Connector;
	owner: ResourceOwner;
	tools: ToolsQuery;
	setToolAccess: (toolAccess: Record<string, ConnectorAccess>) => void;
	onOpenTools: () => void;
}) {
	const canManage = resourcePermissions(owner).manageConnectors;
	const projectId = resourceProjectId(owner);
	const name = ownerName(owner);
	const actions = useConnectorActions(projectId);
	const installApp = useInstallGitHubApp(projectId);
	const navigateToOwnerPage = useNavigateToOwnerPage();
	const [removing, setRemoving] = useState(false);
	const [replacingSecret, setReplacingSecret] = useState(false);
	const builtIn = builtInConnectorFor(connector.url);
	// A GitHub connector works through its app: it has no address to sign in to or check.
	const isServer = connector.kind !== "github";
	const error =
		actions.update.error ?? actions.signIn.error ?? actions.test.error ?? installApp.error;
	const signIn = () => actions.signIn.mutate({ connectorId: connector.id });
	const install = () => installApp.mutate(connector.id);

	async function disconnect() {
		try {
			await actions.remove.mutateAsync({ connectorId: connector.id });
		} catch {
			return;
		}
		setRemoving(false);
		await navigateToOwnerPage(owner, { page: "connectors" }, { replace: true });
	}

	return (
		// Untitled: the page's header names the connector, so its groups head at level 2.
		<SettingsPage
			hero={<ConnectorPageMark connector={connector} />}
			description={
				connector.connectedBy ? `Connected by ${connector.connectedBy.name}` : `For ${name}`
			}
		>
			{error && <Alert>{failureMessage(error)}</Alert>}
			<SettingsGroup
				label={connector.auth === "oauth" || !isServer ? "Account" : "Connector"}
				headingLevel={2}
				// A test is a button under the group, with how it went beside it, so it never moves the page.
				note={isServer && <TestConnector connector={connector} projectId={projectId} />}
			>
				{(connector.auth === "oauth" || !isServer) && (
					<SettingsRow
						label={
							connector.signInExpired
								? "Sign-in expired"
								: isServer
									? "Signed in as"
									: "Installed by"
						}
						sub={accountRowNote(connector)}
						trailing={
							connector.signedIn ? (
								<span className="flex min-w-0 items-center gap-3">
									<ConnectedBy member={isServer ? connector.signedInAs : connector.connectedBy} />
									{canManage &&
										(isServer ? (
											connector.auth === "oauth" && (
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
										{connector.signInExpired ? "Sign in again" : "Sign in"}
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
				{/* A built-in connector is known by its name; only a server added by URL is told apart by it. */}
				{!builtIn && isServer && (
					<SettingsRow
						label="Address"
						trailing={
							<span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
								{connector.url}
							</span>
						}
					/>
				)}
				{isServer && connector.auth === "header" && (
					<SettingsRow
						label={connector.secretHeader === null ? "Access token" : "Secret"}
						sub={
							connector.secretHeader === null
								? "None yet"
								: `Sent in the ${connector.secretHeader} header`
						}
						trailing={
							canManage && (
								<SettingsRowButton onClick={() => setReplacingSecret(true)}>
									{secretActionLabel(connector)}
								</SettingsRowButton>
							)
						}
					/>
				)}
				{replacingSecret && (
					<SecretForm
						connector={connector}
						projectId={projectId}
						done={() => setReplacingSecret(false)}
					/>
				)}
			</SettingsGroup>
			{connector.kind === "github" && (
				<GitHubRepositoriesGroup
					projectId={projectId}
					connectorId={connector.id}
					appSettingsUrl={connector.appSettingsUrl ?? connector.url}
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
					label={`Disconnect ${connector.name}`}
					description={`${name} loses access straight away.`}
					action="Disconnect"
					onClick={() => setRemoving(true)}
				/>
			)}
			<DeleteDialog
				open={removing}
				onOpenChange={setRemoving}
				title={`Disconnect ${connector.name}?`}
				description={
					connector.kind === "github" ? (
						<>
							{name} can no longer use its tools or its repositories. Its app stays on GitHub until
							you delete it there:{" "}
							<a
								href={`${connector.appSettingsUrl ?? connector.url}/advanced`}
								target="_blank"
								rel="noreferrer"
								className="focus-ring rounded-sm font-medium text-link"
							>
								Delete GitHub App
							</a>{" "}
							in its advanced settings.
						</>
					) : (
						`${name} can no longer use its tools. Connecting it again means signing in or entering its details again.`
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
 * Test connector, with how the last check went beside it rather than under
 * it, so a check never moves the page. A failure says why in a line, with the
 * way to fix it next to that.
 */
function TestConnector({ connector, projectId }: { connector: Connector; projectId: string }) {
	const actions = useConnectorActions(projectId);
	const checked =
		actions.test.variables?.connectorId === connector.id ? actions.test.data : undefined;
	const reachable = checked ? checked.reachable : connector.status === "error" ? false : undefined;
	const failure = checked
		? (checked.error ?? "The server did not answer.")
		: (connector.lastTestError ?? "The last check failed.");
	return (
		<span className="flex min-w-0 items-center gap-3">
			<Button
				variant="secondary"
				size="sm"
				disabled={actions.test.isPending}
				onClick={() => actions.test.mutate({ connectorId: connector.id })}
			>
				Test connector
			</Button>
			{actions.test.isPending ? (
				<span className="text-subtle-foreground">Checking…</span>
			) : reachable === true ? (
				<SettingsTestOutcome good>
					{connector.kind === "http"
						? "The address is allowed. A check sends no request to it."
						: "Connector answered"}
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

/** Whoever signed the connector in, with their face. */
function ConnectedBy({ member }: { member: NamedMember | null }) {
	if (member === null) return <SettingsValue>Someone no longer here</SettingsValue>;
	return (
		<span className="flex min-w-0 items-center gap-2">
			<MemberAvatar member={member} size={20} />
			<SettingsValue>{member.name}</SettingsValue>
		</span>
	);
}

/** Why bots can't use the connector yet, while it has no account to work through. */
function accountRowNote(connector: Connector): string | undefined {
	if (connector.signedIn) return undefined;
	if (connector.kind === "github") {
		return "Bots can't use GitHub until the project's app is installed on the account they work on.";
	}
	if (connector.signInExpired) {
		return `${connector.name} refused the last sign-in. Bots can't use it until someone signs in again.`;
	}
	return `Bots can't use ${connector.name} until someone signs in.`;
}

/** What changing a header connector's secret is called: adding one, or replacing the one it has. */
function secretActionLabel(connector: Connector): string {
	if (connector.secretHeader === null) return "Add access token";
	return connector.hasSecret ? "Replace secret" : "Add secret";
}

/** A new secret for a header connector, or its first access token, in a row of its own group. */
function SecretForm({
	connector,
	projectId,
	done,
}: {
	connector: Connector;
	projectId: string;
	done: () => void;
}) {
	const actions = useConnectorActions(projectId);
	const [secret, setSecret] = useState("");
	const needsToken = connector.secretHeader === null;

	async function save(event: FormEvent) {
		event.preventDefault();
		if (!secret) return;
		try {
			await actions.update.mutateAsync({
				connectorId: connector.id,
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
				aria-label={`${connector.name} secret`}
				type="password"
				autoComplete="off"
				// biome-ignore lint/a11y/noAutofocus: opened by asking to change it, so typing is next.
				autoFocus
				value={secret}
				onChange={(event) => setSecret(event.target.value)}
				placeholder={needsToken ? "Paste the access token" : "Paste the new secret"}
				className="min-w-0 flex-1 bg-transparent font-mono text-xs text-foreground outline-none placeholder:text-subtle-foreground"
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

/** A connector's tools in its two kinds, and what each kind is set to before any tool is set apart. */
interface ToolKind {
	kind: "read" | "change";
	tools: ConnectorToolSetting[];
	/** What most of its tools are set to: the group's setting, which a tool set apart differs from. */
	setting: ConnectorAccess;
}

/** Where a kind's setting starts when its tools are split evenly: reads run, changes ask. */
const KIND_LEANING: Record<ToolKind["kind"], ConnectorAccess> = { read: "allow", change: "ask" };

/** The connector's tools that only read, then those that may make changes, leaving out an empty kind. */
function toolKinds(tools: readonly ConnectorToolSetting[]): ToolKind[] {
	return [
		{ kind: "read" as const, tools: tools.filter((tool) => !connectorToolWritesOrDeletes(tool)) },
		{ kind: "change" as const, tools: tools.filter(connectorToolWritesOrDeletes) },
	].flatMap(({ kind, tools: ofKind }) =>
		ofKind.length === 0 ? [] : [{ kind, tools: ofKind, setting: settingOf(ofKind, kind) }],
	);
}

/** The access most of `tools` have, leaning as the kind does when two are tied. */
function settingOf(tools: readonly ConnectorToolSetting[], kind: ToolKind["kind"]) {
	const count = (access: ConnectorAccess) => tools.filter((tool) => tool.access === access).length;
	const leaning = KIND_LEANING[kind];
	return (["allow", "ask", "off"] as const).reduce<ConnectorAccess>(
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

/** How many tools show before the list scrolls inside its card rather than lengthening the page. */
const TOOLS_SHOWN_BEFORE_SCROLLING = 8;

const KIND_WORDS = {
	read: {
		heading: "Tools that read",
		all: (count: number) => `All ${countOf(count, "read tool", "read tools")}`,
		sub: "Look things up without changing anything",
	},
	change: {
		heading: "Tools that make changes",
		all: (count: number) => `All ${countOf(count, "change tool", "change tools")}`,
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
	setToolAccess: (toolAccess: Record<string, ConnectorAccess>) => void;
	onOpenTools: () => void;
}) {
	if (tools.isPending) {
		return (
			<div role="status" aria-label="Loading tools" className="flex flex-col gap-3">
				<div className={cn(SETTINGS_CARD, "h-23 animate-pulse")} />
				<div className={cn(SETTINGS_CARD, "h-23 animate-pulse")} />
			</div>
		);
	}
	if (tools.isError) return <Alert>{failureMessage(tools.error)}</Alert>;
	const kinds = toolKinds(tools.data.tools);
	if (kinds.length === 0) {
		return (
			<SettingsGroup label="Tools" headingLevel={2}>
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
						headingLevel={2}
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
				<div className="flex min-w-0 flex-1 flex-col gap-0.5 leading-snug">
					<h3 id={headingId} className="m-0 font-medium text-xs text-foreground">
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

/** The connector's mark at the head of its pages. */
function ConnectorPageMark({ connector }: { connector: Connector }) {
	return <ConnectorMark markId={connectorMarkFor(connector)} name={connector.name} size="lg" />;
}

/**
 * Every tool on a page of its own: those set apart from their kind first, each
 * saying what its kind is set to, with the way to put them all back; then the
 * rest by kind. Searching narrows all of them.
 */
function IndividualTools({
	connector,
	tools,
	canManage,
	setToolAccess,
	error,
	back,
}: {
	connector: Connector;
	tools: readonly ConnectorToolSetting[];
	canManage: boolean;
	setToolAccess: (toolAccess: Record<string, ConnectorAccess>) => void;
	error: unknown;
	back: ReactNode;
}) {
	const search = useSearchFilter(tools, (tool) => [tool.name, wordsFromKey(tool.name)]);
	const matched = new Set(search.matches);
	const matches = (tool: ConnectorToolSetting) => matched.has(tool);
	const kinds = toolKinds(tools);
	const apart = setApart(kinds);
	const shownApart = apart.filter(({ tool }) => matches(tool));
	const row = (tool: ConnectorToolSetting, setting: ConnectorAccess, changed: boolean) => (
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
			sub={changed ? `Default: ${TOOL_ACCESS_LABELS[setting].toLowerCase()}` : undefined}
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
			hero={<ConnectorPageMark connector={connector} />}
			title="Individual tools"
			description={`Set a tool of ${connector.name} differently from its group.`}
		>
			{Boolean(error) && <Alert>{failureMessage(error)}</Alert>}
			{/* One card, searched from its top and read down: a long list scrolls inside it rather than lengthening the page. */}
			<section aria-label="Tools" className={SETTINGS_CARD}>
				{/* Above the list and as solid as the card, so no row shows past the list's top as it scrolls. */}
				<div className="relative z-1 border-border border-b bg-settings-card p-2.5">
					<SearchField
						label="Search tools"
						placeholder={`Search ${tools.length} ${connector.name} tools`}
						look="outline"
						value={search.query}
						onChange={search.setQuery}
					/>
				</div>
				{/* Sized by every tool, not those a search leaves, so searching never resizes it. */}
				<div
					className={cn(
						tools.length > TOOLS_SHOWN_BEFORE_SCROLLING &&
							// Relative, so the hidden radios inside are held to it: placed by the page instead, those scrolled out of view would lengthen it.
							"relative h-tool-list overflow-y-auto scrollbar-gutter-stable",
						// Its sticky headings layered within it, under the search and the page's Back.
						"isolate",
						// A phone's scrollbar floats over the list, and pulling past its top would open a gap under the search.
						"max-md:overscroll-none max-md:scrollbar-gutter-auto",
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
								description={`Follow the group's setting, ${TOOL_ACCESS_LABELS[setting]}, until one is set differently.`}
							>
								{shown.map((tool) => row(tool, setting, false))}
							</ToolSection>
						);
					})}
					{!anyShown && (
						<p className="m-0 px-4 py-8 text-center text-xs text-subtle-foreground">
							No tools match.
						</p>
					)}
				</div>
			</section>
		</SettingsPage>
	);
}
