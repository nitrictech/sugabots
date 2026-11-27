import { Accordion } from "@base-ui/react/accordion";
import {
	type Bot,
	type BuiltInConnector,
	builtInConnectorFor,
	builtInConnectors,
	type Connector,
	connectorMarkFor,
	type Project,
	type ProjectBotConnector,
	type UnsavedConnector,
} from "@sugabots/contracts";
import { isApiFailure } from "@sugabots/sdk";
import { cn } from "cn";
import { ArrowUpRight, ChevronDown, ChevronRight, Code, Globe, Info } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import {
	bearerAuthorization,
	connectorNeedsAttention,
	useConnectorActions,
	useConnectors,
	useProjectBotConnectors,
	useSetProjectBotConnectorOn,
} from "@/lib/connectors.ts";
import { failureMessage } from "@/lib/failure.ts";
import { useProjectBots } from "@/lib/projects.ts";
import {
	OwnerLink,
	ownerName,
	type ResourceOwner,
	resourcePermissions,
	resourceProjectId,
	useNavigateToOwnerPage,
} from "@/lib/resource-owner.tsx";
import { BotAvatar } from "@/shell/Bot.tsx";
import { Alert, Success } from "@/ui/alert.tsx";
import { Button, buttonStyles } from "@/ui/button.tsx";
import { ConnectorMark } from "@/ui/connector-mark.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import {
	DialogFormBody,
	DialogFormFooter,
	DialogFormFrame,
	DialogFormHeader,
	DialogFormScroll,
	DialogFormStep,
} from "@/ui/dialog-form.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group.tsx";
import { SearchField, useSearchFilter } from "@/ui/search-field.tsx";
import {
	SettingsFieldRow,
	SettingsGroup,
	SettingsRow,
	SettingsRowIcon,
	SettingsValue,
} from "@/ui/settings-page.tsx";
import { SpacedText } from "@/ui/spaced-text.tsx";
import { Switch } from "@/ui/switch.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";
import { GitHubConnectStep } from "./GitHubConnect.tsx";
import { accessSummaryText } from "./tool-access.tsx";

/*
 * The services a project's bots can reach, as one group on its Connectors
 * page, a bot's being its default project's: each with
 * what its tools are set to, Allow, Ask or Off for all of them at once, and
 * whatever it needs (a sign-in, a reconnect) on its line. A row opens the
 * connector's own page: its address, each of its tools, and removing it.
 * Adding one is a dialog: the app and its sign-in, or any other server or HTTP
 * endpoint by its address. Each tool the server lists starts at its default.
 */

export function ConnectorsSettings({
	owner,
	signInError,
	adding,
	onAddingChange,
}: {
	/** The bot or project whose connectors these are. */
	owner: ResourceOwner;
	/** Why the OAuth sign-in that just returned here did not finish, in our own words. */
	signInError?: string;
	/** Whether the Add connector dialog is open; the page's header opens it. */
	adding: boolean;
	onAddingChange: (adding: boolean) => void;
}) {
	const canManage = resourcePermissions(owner).manageConnectors;
	const projectId = resourceProjectId(owner);
	const connectors = useConnectors(projectId);
	if (connectors.isPending) return null;
	if (connectors.isError) return <Alert>{failureMessage(connectors.error)}</Alert>;
	const listed = connectors.data;
	const taken = new Set(listed.map((one) => builtInConnectorFor(one.url)?.id));

	return (
		<>
			{signInError && <Alert>Signing in did not finish: {signInError}</Alert>}
			<SettingsGroup
				label={"project" in owner ? `${ownerName(owner)}'s own` : undefined}
				headingLevel={2}
				note="Bots act as whoever connected each one. Open one to choose for each tool."
			>
				{listed.map((one) => (
					<ConnectorRow key={one.id} connector={one} owner={owner} canManage={canManage} />
				))}
				{listed.length === 0 && (
					<SettingsRow label={<span className="text-muted-foreground">No connectors yet</span>} />
				)}
			</SettingsGroup>
			{canManage && (
				<Dialog open={adding} onOpenChange={onAddingChange}>
					{adding && (
						<AddConnectorDialog
							projectId={projectId}
							addingTo={ownerName(owner)}
							available={builtInConnectors.filter((builtIn) => !taken.has(builtIn.id))}
							offersGitHub={!listed.some((one) => one.kind === "github")}
							done={() => onAddingChange(false)}
						/>
					)}
				</Dialog>
			)}
		</>
	);
}

/**
 * The own connectors of each of a project's bots, which live in the bot and
 * stay off in the project until the workspace's owner or an admin turns each
 * on there: a
 * row for each bot that has any, saying how many are on, which opens in place
 * to list them, each with where it sends data and a switch.
 */
export function ProjectBotsConnectors({ project }: { project: Project }) {
	const canManage = resourcePermissions({ project }).manageConnectors;
	const bots = useProjectBots(project.id);
	const connectors = useProjectBotConnectors(project.id);
	if (!bots.data || !connectors.data) {
		// A reload that fails once the rows are shown leaves them in place.
		const failed = bots.error ?? connectors.error;
		return failed ? <Alert>{failureMessage(failed)}</Alert> : null;
	}
	const listed = connectors.data;
	const withConnectors = bots.data.filter((bot) => listed.some((one) => one.botId === bot.id));
	if (withConnectors.length === 0) return null;
	return (
		<SettingsGroup
			label="Its bots' own"
			headingLevel={2}
			note={`A bot's own connectors stay off in ${project.name} until the workspace's owner or an admin turns them on here. While one is on, the bot can send it what it reads in ${project.name}'s chats. If its address changes, it turns off again until one of them turns it back on.`}
		>
			<Accordion.Root multiple>
				{withConnectors.map((bot) => (
					<BotConnectors
						key={bot.id}
						bot={bot}
						project={project}
						connectors={listed.filter((one) => one.botId === bot.id)}
						canManage={canManage}
					/>
				))}
			</Accordion.Root>
		</SettingsGroup>
	);
}

function BotConnectors({
	bot,
	project,
	connectors,
	canManage,
}: {
	bot: Bot;
	project: Project;
	connectors: readonly ProjectBotConnector[];
	canManage: boolean;
}) {
	const setOn = useSetProjectBotConnectorOn(project.id);
	const on = connectors.filter((one) => one.on).length;
	return (
		<Accordion.Item className="border-border border-b last:border-b-0">
			<Accordion.Header className="m-0">
				<SettingsRow
					render={<Accordion.Trigger className="group/bot-connectors" />}
					className="border-b-0"
					icon={<BotAvatar color={bot.color} eyes={bot.eyes} shape={bot.shape} size={34} />}
					label={bot.name}
					sub={on === 0 ? "All off here" : `${on} of ${connectors.length} on here`}
					trailing={
						<>
							<span aria-hidden className="flex shrink-0 gap-1">
								{connectors.slice(0, MARKS_SHOWN).map((one) => (
									<ConnectorMark
										key={one.id}
										markId={connectorMarkFor(one)}
										name={one.name}
										size="md"
									/>
								))}
							</span>
							<ChevronDown
								aria-hidden
								size={14}
								strokeWidth={2}
								className="shrink-0 text-subtle-foreground transition-transform group-data-panel-open/bot-connectors:rotate-180"
							/>
						</>
					}
				/>
			</Accordion.Header>
			<Accordion.Panel className="h-(--accordion-panel-height) overflow-hidden transition-height duration-200 ease-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
				<div className="flex flex-col gap-1 pr-4 pb-3 pl-16">
					{connectors.map((connector) => (
						<BotConnectorRow
							key={connector.id}
							bot={bot}
							project={project}
							connector={connector}
							canManage={canManage}
							pending={setOn.isPending}
							refusal={
								setOn.error && setOn.variables?.connectorId === connector.id
									? refusalLine(setOn.error, setOn.variables.addressRevision, connector)
									: undefined
							}
							onChange={(on) =>
								setOn.mutate({
									connectorId: connector.id,
									on,
									addressRevision: connector.addressRevision,
								})
							}
						/>
					))}
					{bot.permissions.resources.manageConnectors && (
						<OwnerLink
							owner={{ bot }}
							to={{ page: "connectors" }}
							className={cn(
								buttonStyles({ size: "sm", variant: "secondary" }),
								"mt-1.5 self-start",
							)}
						>
							Edit in {bot.name}
						</OwnerLink>
					)}
				</div>
			</Accordion.Panel>
		</Accordion.Item>
	);
}

/**
 * One of a bot's own connectors in the project: where it sends data, and its
 * switch, or whether it is on for someone who can't change it. Why turning it
 * on or off just failed takes the place of its line.
 */
function BotConnectorRow({
	bot,
	project,
	connector,
	canManage,
	pending,
	refusal,
	onChange,
}: {
	bot: Bot;
	project: Project;
	connector: ProjectBotConnector;
	canManage: boolean;
	pending: boolean;
	refusal: string | undefined;
	onChange: (on: boolean) => void;
}) {
	const lineId = useId();
	const line = refusal ?? botConnectorLine(connector, canManage);
	return (
		<div className="flex min-w-0 items-center gap-3 py-1.5">
			<ConnectorMark markId={connectorMarkFor(connector)} name={connector.name} size="md" />
			<span className="flex min-w-0 flex-1 flex-col leading-snug">
				<span className="truncate text-sm text-foreground">{connector.name}</span>
				{line !== undefined && (
					<span
						id={lineId}
						className={cn(
							"text-pretty text-xs",
							refusal !== undefined || connector.addressChanged
								? "text-destructive-text"
								: "text-subtle-foreground",
						)}
					>
						{line}
					</span>
				)}
			</span>
			{canManage ? (
				<Tooltip
					label={
						connector.on
							? `Stop ${bot.name} using ${connector.name} in ${project.name}`
							: `Let ${bot.name} use ${connector.name} in ${project.name}`
					}
					side="top"
				>
					<Switch
						checked={connector.on}
						disabled={pending}
						aria-label={`${bot.name}'s ${connector.name}`}
						aria-describedby={line !== undefined ? lineId : undefined}
						onCheckedChange={onChange}
					/>
				</Tooltip>
			) : (
				<SettingsValue>{connector.on ? "On" : "Off"}</SettingsValue>
			)}
		</div>
	);
}

/**
 * What a bot's own connector's line says under its name: whether its address
 * changed since it was turned on here, where it sends data, to those who may
 * see that, and, to those who can't turn it on or off, who can.
 */
function botConnectorLine(connector: ProjectBotConnector, canManage: boolean): string | undefined {
	if (connector.addressChanged) {
		const changed =
			connector.url === null ? "Its address changed" : `Its address changed to ${connector.url}`;
		return canManage
			? `${changed}. Turn it on to use the new address`
			: `${changed}. It's off until the workspace's owner or an admin turns it on again`;
	}
	const sendsTo = connector.url === null ? undefined : `Sends data to ${connector.url}`;
	if (canManage) return sendsTo;
	const whoChanges = "Only the workspace's owner and admins can change this";
	return sendsTo ? `${sendsTo}. ${whoChanges}` : whoChanges;
}

/**
 * Why turning `connector` on or off failed. When its address changed after
 * the revision `triedRevision` was shown, the list is read again; once it
 * has its new address, that is what the line says.
 */
function refusalLine(
	failure: unknown,
	triedRevision: number,
	connector: ProjectBotConnector,
): string {
	const addressChanged = isApiFailure(failure) && failure.error?._tag === "ConnectorAddressChanged";
	if (!addressChanged || connector.addressRevision === triedRevision || connector.url === null)
		return failureMessage(failure);
	return `Its address is now ${connector.url}. Check it, then turn it on again`;
}

/** How many of a bot's connectors its row shows the marks of. */
const MARKS_SHOWN = 4;

/**
 * What a connector's line says under its name: what it needs, or what its
 * tools are set to and who it signs in as.
 */
function connectorLineParts(connector: Connector): readonly string[] {
	if (connector.signInExpired)
		return ["Sign-in expired. Bots can't use it until someone signs in again"];
	if (!connector.signedIn) return ["Not signed in yet"];
	if (connector.status === "error") return [connector.lastTestError ?? "The last check failed"];
	const access = accessSummaryText(connector.toolCounts) ?? "No tools found yet";
	return connector.signedInAs ? [access, `Signed in as ${connector.signedInAs.name}`] : [access];
}

function ConnectorRow({
	connector,
	owner,
	canManage,
}: {
	connector: Connector;
	owner: ResourceOwner;
	canManage: boolean;
}) {
	const actions = useConnectorActions(resourceProjectId(owner));
	const navigateToOwnerPage = useNavigateToOwnerPage();
	const page = { page: "connector", connectorId: connector.id } as const;
	const needsSignIn = !connector.signedIn;
	const failing = connector.signInExpired || (connector.signedIn && connector.status === "error");
	const pending = actions.update.isPending || actions.signIn.isPending;
	const error = actions.update.error ?? actions.signIn.error;
	// A failing secret or address is fixed on the connector's own page.
	const reconnect = () =>
		connector.auth === "oauth"
			? actions.signIn.mutate({ connectorId: connector.id })
			: void navigateToOwnerPage(owner, page);
	const line = error ? [failureMessage(error)] : connectorLineParts(connector);

	return (
		<article
			aria-label={connector.name}
			className="relative flex min-h-14 items-center gap-3.5 border-border border-b px-4 py-3 transition-colors last:border-b-0 hover:bg-settings-row-hover active:bg-row-selected"
		>
			{/* Its link covers the whole row; the controls sit above it. */}
			<OwnerLink
				owner={owner}
				to={page}
				aria-label={`${connector.name}, ${line.join(", ")}. Open tools`}
				className="focus-ring flex min-w-0 flex-1 items-center gap-3.5 rounded-lg text-left after:absolute after:inset-0"
			>
				<ConnectorMark markId={connectorMarkFor(connector)} name={connector.name} size="tile" />
				<span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-snug">
					<span className="truncate text-sm text-foreground">{connector.name}</span>
					<span
						className={cn(
							"text-pretty text-xs",
							failing || error ? "line-clamp-2 text-destructive-text" : "text-subtle-foreground",
						)}
					>
						<SpacedText parts={line} />
					</span>
				</span>
			</OwnerLink>
			<span className="relative ml-auto flex shrink-0 items-center gap-2">
				{canManage && connectorNeedsAttention(connector) && (
					<Button size="sm" variant="secondary" disabled={pending} onClick={reconnect}>
						{connector.signInExpired
							? "Sign in again"
							: needsSignIn
								? "Sign in"
								: connector.auth === "oauth"
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

type Choice = BuiltInConnector | "custom" | "http" | "github";

/** Adding a connector: which built-in connector, then its sign-in, or any other server by its address. */
function AddConnectorDialog({
	projectId,
	addingTo,
	available,
	offersGitHub,
	done,
}: {
	projectId: string;
	/** Who the connector is added to: the bot or project, by name. */
	addingTo: string;
	available: readonly BuiltInConnector[];
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
				<BuiltInConnectorStep
					projectId={projectId}
					builtIn={choice}
					onBack={() => setChoice(undefined)}
				/>
			) : (
				<BuiltInConnectorList
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

/** GitHub as the list of built-in connectors shows it, beside the hosted MCP servers; it connects through a GitHub app of the project's own. */
const GITHUB_APP = {
	choice: "github",
	id: "github",
	name: "GitHub",
	description: "Repositories, issues and pull requests",
} as const;

function BuiltInConnectorList({
	addingTo,
	available,
	offersGitHub,
	onChoose,
	done,
}: {
	/** Who the connector is added to: the bot or project, by name. */
	addingTo: string;
	available: readonly BuiltInConnector[];
	offersGitHub: boolean;
	onChoose: (choice: Choice) => void;
	done: () => void;
}) {
	const choices = [
		...(offersGitHub ? [GITHUB_APP] : []),
		...available.map((builtIn) => ({ ...builtIn, choice: builtIn })),
	];
	const { query, setQuery, searching, matches } = useSearchFilter(choices, (offered) => [
		offered.name,
		offered.description,
	]);
	return (
		<DialogFormStep onSubmit={(event) => event.preventDefault()}>
			<DialogFormHeader title={`Add to ${addingTo}`} />
			<DialogFormBody>
				<SearchField label="Search connectors" value={query} onChange={setQuery} />
				<DialogFormScroll height="picker">
					{matches.length > 0 && (
						<SettingsGroup>
							{matches.map((offered) => (
								<SettingsRow
									key={offered.id}
									icon={<ConnectorMark markId={offered.id} name={offered.name} size="tile" />}
									label={offered.name}
									sub={offered.description}
									chevron
									onClick={() => onChoose(offered.choice)}
								/>
							))}
						</SettingsGroup>
					)}
					{matches.length === 0 && searching && (
						<p className="m-0 px-1 text-muted-foreground text-xs">
							No connector matches “{query.trim()}”.
						</p>
					)}
					<SettingsGroup
						label="Something else"
						action={
							<IconButton
								label="For a service that offers its tools as an MCP server. The service gives you the address to paste."
								size="sm"
								side="top"
							>
								<Info strokeWidth={2} />
							</IconButton>
						}
					>
						<SettingsRow
							icon={
								<SettingsRowIcon className="size-9 rounded-lg">
									<Code size={15} strokeWidth={2.2} />
								</SettingsRowIcon>
							}
							label="Connect by URL"
							sub="Another service's tools, from the link it gives you"
							chevron
							onClick={() => onChoose("custom")}
						/>
						<SettingsRow
							icon={
								<SettingsRowIcon className="size-9 rounded-lg">
									<Globe size={15} strokeWidth={2.2} />
								</SettingsRowIcon>
							}
							label="HTTP endpoint"
							sub="Any web API, by its base address"
							chevron
							onClick={() => onChoose("http")}
						/>
					</SettingsGroup>
				</DialogFormScroll>
			</DialogFormBody>
			<DialogFormFooter onCancel={done} />
		</DialogFormStep>
	);
}

/**
 * A built-in connector: what it is. Connecting makes it and leaves for its sign-in,
 * which brings the browser back to these connectors.
 */
function BuiltInConnectorStep({
	projectId,
	builtIn,
	onBack,
}: {
	projectId: string;
	builtIn: BuiltInConnector;
	onBack: () => void;
}) {
	const actions = useConnectorActions(projectId);

	function submit(event: FormEvent) {
		event.preventDefault();
		actions.connect.mutate({ name: builtIn.name, url: builtIn.url });
	}

	return (
		<DialogFormStep onSubmit={submit}>
			<DialogFormHeader
				title={builtIn.name}
				onBack={onBack}
				backDisabled={actions.connect.isPending}
			/>
			<DialogFormBody>
				<div className="flex flex-col items-center gap-1.5 pb-1 text-center">
					<ConnectorMark markId={builtIn.id} name={builtIn.name} />
					<span className="text-xs text-muted-foreground">{builtIn.description}</span>
				</div>
				{actions.connect.error && <Alert>{failureMessage(actions.connect.error)}</Alert>}
				<Button
					type="submit"
					size="lg"
					className="mt-2 w-full"
					disabled={actions.connect.isPending}
				>
					Connect {builtIn.name}
					<ArrowUpRight aria-hidden />
				</Button>
				<p className="m-0 text-center text-xs text-subtle-foreground">
					You'll sign in to {builtIn.name} next.
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
	const actions = useConnectorActions(projectId);
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
	const server: UnsavedConnector =
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
							<RadioGroup
								aria-label="How to sign in to the server"
								value={method}
								onValueChange={clearingOutcome(setMethod)}
							>
								{(isEndpoint
									? signInMethodOptions.filter((option) => option.value !== "oauth")
									: signInMethodOptions
								).map((option) => (
									<RadioGroupItem key={option.value} value={option.value}>
										{option.label}
									</RadioGroupItem>
								))}
							</RadioGroup>
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
					(outcome.ok ? <Success>Connector answered</Success> : <Alert>{outcome.message}</Alert>)}
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
