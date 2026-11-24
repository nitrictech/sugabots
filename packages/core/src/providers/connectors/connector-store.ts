export * as ConnectorStore from "./connector-store.ts";

import type { ConnectorTool, ConnectorUpdate, NewConnector } from "@sugabots/contracts";
import { handleFromName } from "@sugabots/contracts";
import { type UserText, userText } from "@sugabots/errors";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Context, Data, DateTime, Effect, Layer } from "effect";
import { query, queryCatching, serviceOperations, transaction } from "../../database/database.ts";
import { isUniqueViolation } from "../../database/errors.ts";
import {
	type ConnectorRow,
	connector,
	type GitHubConnectorRepository,
	type GitHubConnectorSettings,
	type ToolAccess,
} from "../../database/schema.ts";
import { Secrets } from "../../secrets/secrets.ts";
import type { UserFacing } from "../../user-message.ts";
import { changesAddress, stillConfiguredAs } from "../tested-configuration.ts";
import { type AugmentationTool, augmentConnectorTools } from "./augmentations.ts";
import type { ConnectorTarget } from "./connector-target.ts";
import { GITHUB_CONNECTOR_TOOLS } from "./github/github-tools.ts";
import { HTTP_CONNECTOR_TOOLS } from "./http-tools.ts";
import type { OAuthRecord } from "./oauth.ts";
import { toolAccessOf } from "./tool-access.ts";

/**
 * The only writer of `connector`: the MCP servers, HTTP endpoints and GitHub
 * apps each project is connected to, the MCP servers' sealed secrets and OAuth
 * records, and the apps' sealed credentials.
 *
 * A name, and the handle made from it, is unique per project. `target` does
 * not look at what bots may do with the tools: a connector whose tools are
 * all off can still be tested.
 *
 * What a member chooses for a tool is not a change of configuration: it
 * leaves `configurationRevision`, and the approvals made under it, alone.
 * An approved call to a tool turned off since is refused when it would run.
 *
 * A new address takes away the stored secret, unless one comes with it, and
 * the OAuth record, so a connector signed in through OAuth must sign in again.
 */
export interface Interface {
	readonly create: (
		workspaceId: string,
		projectId: string,
		memberId: string,
		input: NewConnector,
	) => Effect.Effect<ConnectorRow, ConnectorNameTaken>;
	/**
	 * Gives the project a GitHub connector to the app made for it, `id`. It
	 * waits on `installed` before it is signed in.
	 */
	readonly createGitHub: (
		workspaceId: string,
		projectId: string,
		memberId: string,
		input: {
			id: string;
			app: Pick<GitHubConnectorSettings, "appId" | "slug" | "owner">;
			appCredentialEncrypted: string;
		},
	) => Effect.Effect<ConnectorRow, ConnectorNameTaken>;
	/**
	 * Records the account the connector's app was installed on, or installed
	 * on again, and `installedById`, the member who installed it there when the
	 * account is their own; answers whether the connector is still there.
	 */
	readonly installed: (
		workspaceId: string,
		connectorId: string,
		installation: { installationId: number; account: string; installedById: string | null },
	) => Effect.Effect<boolean>;
	/**
	 * Forgets the installations of the workspace's GitHub apps that
	 * `memberId` installed on their own GitHub account, so each project must
	 * install its app again, and answers what each was, to uninstall it at GitHub.
	 */
	readonly forgetGitHubInstallationsBy: (
		workspaceId: string,
		memberId: string,
	) => Effect.Effect<readonly ForgottenInstallation[]>;
	/**
	 * Changes a GitHub connector's repositories to what `change` makes of
	 * them, with the connector locked meanwhile, so two changes made at once
	 * both land. A change to which repositories it has, not only to how they
	 * are written, is a change of configuration. Answers the repositories as
	 * they now are, or undefined for no such GitHub connector.
	 */
	readonly changeGitHubRepositories: (
		workspaceId: string,
		connectorId: string,
		change: (
			repositories: readonly GitHubConnectorRepository[],
		) => readonly GitHubConnectorRepository[],
	) => Effect.Effect<readonly GitHubConnectorRepository[] | undefined>;
	readonly update: (
		workspaceId: string,
		projectId: string,
		connectorId: string,
		changes: ConnectorUpdate,
	) => Effect.Effect<ConnectorRow | undefined, ConnectorNameTaken | UnknownConnectorTool>;
	readonly remove: (
		workspaceId: string,
		projectId: string,
		connectorId: string,
	) => Effect.Effect<boolean>;
	/**
	 * Records what a test of the configuration last updated at `testedAt`
	 * found, unless the connector has been reconfigured since.
	 */
	readonly recordTest: (
		workspaceId: string,
		connectorId: string,
		testedAt: Date,
		outcome: TestOutcome,
	) => Effect.Effect<void>;
	readonly target: (
		workspaceId: string,
		projectId: string,
		connectorId: string,
	) => Effect.Effect<ConnectorTarget | undefined>;
	/**
	 * The MCP servers and HTTP endpoints a turn may use. A connector still
	 * waiting on its sign-in offers nothing, and neither does one whose every
	 * listed tool is off, so a turn does not reach its server at all.
	 */
	readonly targetsForProject: (
		workspaceId: string,
		projectId: string,
	) => Effect.Effect<ProjectTargets>;
	/** What the OAuth client has learnt and been issued, unsealed. */
	readonly oauthRecord: (
		workspaceId: string,
		connectorId: string,
	) => Effect.Effect<OAuthRecord | undefined>;
	/**
	 * Seals the record; its `state` is also kept in the clear so a callback can
	 * find the row. `signedInById` comes with the tokens a sign-in has just been
	 * issued, as the member who finished it; tokens without it are refreshed
	 * ones of the sign-in already there, and a record without any is signed out.
	 */
	readonly saveOauthRecord: (
		workspaceId: string,
		connectorId: string,
		record: OAuthRecord,
		signedInById?: string,
	) => Effect.Effect<void>;
	/**
	 * Takes away the OAuth record of every connector in the workspace whose
	 * tokens `memberId` signed in for, so each must be signed in again. A
	 * secret someone entered stays.
	 */
	readonly signOutSignedInBy: (workspaceId: string, memberId: string) => Effect.Effect<void>;
	/**
	 * The connector a sign-in callback belongs to, by the `state` it carries,
	 * and who started that sign-in, if anybody did.
	 */
	readonly byOauthState: (state: string) => Effect.Effect<
		| {
				workspaceId: string;
				projectId: string;
				connectorId: string;
				startedByMemberId: string | undefined;
		  }
		| undefined
	>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ConnectorStore",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ConnectorStore");
	const cipher = yield* Secrets.Service;

	const toTarget = (row: ConnectorRow): ConnectorTarget => {
		const headers: Record<string, string> = {};
		if (row.secretHeader && row.secretEncrypted) {
			headers[row.secretHeader] = cipher.decrypt(row.secretEncrypted);
		}
		return {
			connectorId: row.id,
			handle: row.handle,
			kind: row.kind,
			url: row.url,
			auth: row.authKind,
			headers,
			toolAccess: row.toolAccess,
			configurationUpdatedAt: row.updatedAt,
			configurationRevision: row.configurationRevision,
		};
	};

	return Service.of({
		create: (workspaceId, projectId, memberId, input) =>
			operation(
				"create",
				Effect.gen(function* () {
					const oauth = input.kind !== "http" && input.auth === "oauth";
					const values = {
						kind: input.kind ?? "mcp",
						name: input.name,
						url: input.url,
						authKind: oauth ? ("oauth" as const) : ("header" as const),
						secretHeader: oauth ? null : (input.secretHeader ?? null),
						secretEncrypted: !oauth && input.secret ? cipher.encrypt(input.secret) : null,
					};
					const [inserted] = yield* queryCatching(
						(db) =>
							db
								.insert(connector)
								.values({
									workspaceId,
									projectId,
									createdById: memberId,
									handle: handleFromName(values.name),
									...values,
								})
								.returning(),
						(failure) => (isUniqueViolation(failure) ? new ConnectorNameTaken() : undefined),
					);
					if (!inserted) {
						return yield* Effect.die(new Error("Connector insert returned no row"));
					}
					return inserted;
				}),
			),

		createGitHub: (workspaceId, projectId, memberId, input) =>
			operation(
				"createGitHub",
				Effect.gen(function* () {
					const name = "GitHub";
					const testedAt = yield* DateTime.nowAsDate;
					const [inserted] = yield* queryCatching(
						(db) =>
							db
								.insert(connector)
								.values({
									workspaceId,
									projectId,
									createdById: memberId,
									kind: "github",
									name,
									handle: handleFromName(name),
									id: input.id,
									url: gitHubAppUrl(input.app.slug),
									settings: {
										kind: "github",
										...input.app,
										installationId: null,
										account: null,
										repositories: [],
									},
									appCredentialEncrypted: input.appCredentialEncrypted,
									lastTestedAt: testedAt,
								})
								.returning(),
						(failure) => (isUniqueViolation(failure) ? new ConnectorNameTaken() : undefined),
					);
					if (!inserted) {
						return yield* Effect.die(new Error("Connector insert returned no row"));
					}
					return inserted;
				}),
			),

		installed: (workspaceId, connectorId, { installationId, account, installedById }) =>
			operation(
				"installed",
				Effect.map(
					query((db) =>
						db
							.update(connector)
							.set({
								url: `https://github.com/${account}`,
								// Merged in SQL, so the app's own settings are kept as they are.
								settings: sql`${connector.settings} || ${JSON.stringify({ installationId, account })}::jsonb`,
								installedById,
								configurationRevision: sql`${connector.configurationRevision} + 1`,
							})
							.where(
								and(
									eq(connector.id, connectorId),
									eq(connector.workspaceId, workspaceId),
									eq(connector.kind, "github"),
								),
							)
							.returning({ id: connector.id }),
					),
					(rows) => rows.length > 0,
				),
			),

		changeGitHubRepositories: (workspaceId, connectorId, change) =>
			operation(
				"changeGitHubRepositories",
				transaction(
					Effect.gen(function* () {
						const where = and(
							eq(connector.id, connectorId),
							eq(connector.workspaceId, workspaceId),
							eq(connector.kind, "github"),
						);
						const [row] = yield* query((db) =>
							db
								.select({ settings: connector.settings })
								.from(connector)
								.where(where)
								.limit(1)
								.for("update"),
						);
						const settings = row?.settings;
						if (!settings) return undefined;
						const before = settings.repositories;
						const after = change(before);
						const ids = (repositories: readonly GitHubConnectorRepository[]) =>
							repositories
								.map((one) => one.id)
								.sort((a, b) => a - b)
								.join();
						yield* query((db) =>
							db
								.update(connector)
								.set({
									settings: { ...settings, repositories: after },
									...(ids(before) === ids(after)
										? {}
										: { configurationRevision: sql`${connector.configurationRevision} + 1` }),
								})
								.where(where),
						);
						return after;
					}),
				),
			),

		update: (workspaceId, projectId, connectorId, changes) =>
			operation(
				"update",
				transaction(
					Effect.gen(function* () {
						const ofProject = and(
							eq(connector.id, connectorId),
							eq(connector.workspaceId, workspaceId),
							eq(connector.projectId, projectId),
						);
						const connectorChanged = changesReach(changes);
						const configurationChanged = changes.name !== undefined || connectorChanged;
						const choosesAccess = changes.access !== undefined || changes.toolAccess !== undefined;
						let chosen: ToolAccess | undefined;
						let moved = false;
						if (changes.url !== undefined || choosesAccess) {
							const [current] = yield* query((db) =>
								db
									.select({ kind: connector.kind, url: connector.url, names: listedToolNames })
									.from(connector)
									.where(ofProject)
									.limit(1)
									.for("update"),
							);
							if (!current) return undefined;
							moved = changesAddress(changes.url, current.url);
							if (choosesAccess) {
								const names = toolsOf({
									kind: current.kind,
									url: current.url,
									tools: current.names.map((name) => ({ name })),
								}).map((tool) => tool.name);
								chosen = yield* choicesFor(names, changes);
							}
						}
						const [row] = yield* queryCatching(
							(db) =>
								db
									.update(connector)
									.set({
										name: changes.name,
										handle: changes.name === undefined ? undefined : handleFromName(changes.name),
										url: changes.url,
										secretHeader: changes.secretHeader,
										secretEncrypted: changes.secret
											? cipher.encrypt(changes.secret)
											: changes.secret === null || moved
												? null
												: undefined,
										// The OAuth client was registered with, and its tokens issued
										// by, the old address's authorization server.
										oauthEncrypted: moved ? null : undefined,
										oauthState: moved ? null : undefined,
										signedInById: moved ? null : undefined,
										toolAccess: chosen
											? sql`${connector.toolAccess} || ${JSON.stringify(chosen)}::jsonb`
											: undefined,
										configurationRevision: configurationChanged
											? sql`${connector.configurationRevision} + 1`
											: undefined,
										lastTestedAt: connectorChanged ? null : undefined,
										lastTestError: connectorChanged ? null : undefined,
									})
									.where(ofProject)
									.returning(),
							(failure) => (isUniqueViolation(failure) ? new ConnectorNameTaken() : undefined),
						);
						return row;
					}),
				),
			),

		remove: (workspaceId, projectId, connectorId) =>
			operation(
				"remove",
				query((db) =>
					db
						.delete(connector)
						.where(
							and(
								eq(connector.id, connectorId),
								eq(connector.workspaceId, workspaceId),
								eq(connector.projectId, projectId),
							),
						)
						.returning({ id: connector.id }),
				).pipe(Effect.map((deleted) => deleted.length > 0)),
			),

		recordTest: (workspaceId, connectorId, testedAt, outcome) =>
			operation(
				"recordTest",
				Effect.gen(function* () {
					const now = yield* DateTime.nowAsDate;
					yield* query((db) =>
						db
							.update(connector)
							.set({
								lastTestedAt: now,
								lastTestError: "error" in outcome ? outcome.error : null,
								tools: "tools" in outcome ? outcome.tools : undefined,
							})
							.where(
								and(
									eq(connector.id, connectorId),
									eq(connector.workspaceId, workspaceId),
									stillConfiguredAs(connector.updatedAt, testedAt),
								),
							),
					);
				}),
			),

		target: (workspaceId, projectId, connectorId) =>
			operation(
				"target",
				query((db) =>
					db
						.select()
						.from(connector)
						.where(
							and(
								eq(connector.id, connectorId),
								eq(connector.workspaceId, workspaceId),
								eq(connector.projectId, projectId),
							),
						)
						.limit(1),
				).pipe(Effect.map(([row]) => row && toTarget(row))),
			),

		targetsForProject: (workspaceId, projectId) =>
			operation(
				"targetsForProject",
				query((db) =>
					db
						.select()
						.from(connector)
						.where(
							and(
								eq(connector.workspaceId, workspaceId),
								eq(connector.projectId, projectId),
								// GitHub's tools work through its app, with no address of its own to reach.
								inArray(connector.kind, ["mcp", "http"]),
							),
						)
						.orderBy(asc(connector.createdAt)),
				).pipe(
					Effect.map((rows) => {
						const used = rows.filter((row) => !everyToolOff(row));
						return {
							targets: used.filter((row) => isSignedIn(row, cipher)).map(toTarget),
							signInExpired: used
								.filter((row) => signInExpired(row, cipher))
								.map((row) => ({ handle: row.handle, url: row.url })),
						};
					}),
				),
			),

		oauthRecord: (workspaceId, connectorId) =>
			operation(
				"oauthRecord",
				query((db) =>
					db
						.select()
						.from(connector)
						.where(and(eq(connector.id, connectorId), eq(connector.workspaceId, workspaceId)))
						.limit(1),
				).pipe(Effect.map(([row]) => row && decryptOauthRecord(row, cipher))),
			),

		saveOauthRecord: (workspaceId, connectorId, record, signedInById) =>
			operation(
				"saveOauthRecord",
				query((db) =>
					db
						.update(connector)
						.set({
							oauthEncrypted: cipher.encrypt(JSON.stringify(record)),
							oauthState: record.state || null,
							signedInById: record.tokens === undefined ? null : signedInById,
							configurationRevision: record.state
								? sql`${connector.configurationRevision} + 1`
								: undefined,
						})
						.where(and(eq(connector.id, connectorId), eq(connector.workspaceId, workspaceId))),
				),
			),

		signOutSignedInBy: (workspaceId, memberId) =>
			operation(
				"signOutSignedInBy",
				query((db) =>
					db
						.update(connector)
						.set({
							oauthEncrypted: null,
							oauthState: null,
							signedInById: null,
							configurationRevision: sql`${connector.configurationRevision} + 1`,
						})
						.where(
							and(eq(connector.workspaceId, workspaceId), eq(connector.signedInById, memberId)),
						),
				),
			),

		forgetGitHubInstallationsBy: (workspaceId, memberId) =>
			operation(
				"forgetGitHubInstallationsBy",
				transaction(
					Effect.gen(function* () {
						const installed = yield* query((db) =>
							db
								.select({
									id: connector.id,
									settings: connector.settings,
									appCredentialEncrypted: connector.appCredentialEncrypted,
								})
								.from(connector)
								.where(
									and(
										eq(connector.workspaceId, workspaceId),
										eq(connector.kind, "github"),
										eq(connector.installedById, memberId),
									),
								)
								.for("update"),
						);
						const forgotten: ForgottenInstallation[] = [];
						for (const { id, settings, appCredentialEncrypted } of installed) {
							// For the types: a GitHub connector always holds its app's credential, and
							// one that records who installed it is installed.
							if (settings?.installationId == null || appCredentialEncrypted === null) continue;
							yield* query((db) =>
								db
									.update(connector)
									.set({
										url: gitHubAppUrl(settings.slug),
										settings: { ...settings, installationId: null, account: null },
										installedById: null,
										configurationRevision: sql`${connector.configurationRevision} + 1`,
									})
									.where(eq(connector.id, id)),
							);
							forgotten.push({
								connectorId: id,
								appId: settings.appId,
								appCredentialEncrypted,
								installationId: settings.installationId,
							});
						}
						return forgotten;
					}),
				),
			),

		byOauthState: (state) =>
			operation(
				"byOauthState",
				query((db) =>
					db.select().from(connector).where(eq(connector.oauthState, state)).limit(1),
				).pipe(
					Effect.map(
						([row]) =>
							row && {
								workspaceId: row.workspaceId,
								projectId: row.projectId,
								connectorId: row.id,
								startedByMemberId: decryptOauthRecord(row, cipher)?.startedByMemberId,
							},
					),
				),
			),
	});
});

export const layer = Layer.effect(Service, make);

/**
 * A GitHub app's installation as it was when it was forgotten: enough to
 * uninstall it at GitHub, signed with the app's own key.
 */
export interface ForgottenInstallation {
	readonly connectorId: string;
	readonly appId: number;
	readonly appCredentialEncrypted: string;
	readonly installationId: number;
}

/** A project's connectors as a turn sees them. */
interface ProjectTargets {
	targets: ConnectorTarget[];
	/**
	 * Connectors that offer nothing until someone signs in again, by handle,
	 * and by address so they still count as ones the project has.
	 */
	signInExpired: Pick<ConnectorTarget, "handle" | "url">[];
}

/**
 * What a test found: the server's tools, absent for a connector whose tools
 * are Sugabots' own, or why it could not be asked.
 */
type TestOutcome = { tools?: ConnectorTool[] } | { error: UserText };

export class ConnectorNameTaken
	extends Data.TaggedError("ConnectorNameTaken")
	implements UserFacing
{
	get userMessage() {
		return userText`A connector with that name already exists here`;
	}
}

export class UnknownConnectorTool
	extends Data.TaggedError("UnknownConnectorTool")<{ names: string[] }>
	implements UserFacing
{
	override get message() {
		return `The connector does not list ${this.names.join(", ")}`;
	}

	get userMessage() {
		return userText`The connector no longer lists some of those tools. Check the connector to refresh them.`;
	}
}

/** A GitHub connector's address until its app is installed on an account: the app's own page. */
function gitHubAppUrl(slug: string) {
	return `https://github.com/apps/${slug}`;
}

/** The names of the tools the server listed when last asked, leaving their descriptions in the database. */
const listedToolNames = sql<string[]>`jsonb_path_query_array(${connector.tools}, '$[*].name')`;

/**
 * The choices `changes` makes: `access` for every tool the server listed, or
 * `toolAccess` for the tools it names, each of which must be listed.
 */
function choicesFor(
	listed: readonly string[],
	changes: Pick<ConnectorUpdate, "access" | "toolAccess">,
): Effect.Effect<ToolAccess, UnknownConnectorTool> {
	const { access, toolAccess = {} } = changes;
	if (access) return Effect.succeed(Object.fromEntries(listed.map((name) => [name, access])));
	const known = new Set(listed);
	const unknown = Object.keys(toolAccess).filter((name) => !known.has(name));
	return unknown.length > 0
		? Effect.fail(new UnknownConnectorTool({ names: unknown }))
		: Effect.succeed(toolAccess);
}

/**
 * A connector's tools: an MCP server's as it listed them when last asked,
 * then its augmentation tools (see `augmentations.ts`); or GitHub's or an
 * HTTP endpoint's, which are Sugabots' own, as this version has them.
 */
export function toolsOf<Tool extends { name: string }>(row: {
	kind: ConnectorRow["kind"];
	url: string;
	tools: readonly Tool[];
}): readonly (Tool | ConnectorTool | AugmentationTool)[] {
	if (row.kind === "github") return GITHUB_CONNECTOR_TOOLS;
	if (row.kind === "http") return HTTP_CONNECTOR_TOOLS;
	return augmentConnectorTools(row, row.tools);
}

/** Whether the connector has tools and every one of them is off. */
export function everyToolOff(row: ConnectorRow): boolean {
	const tools = toolsOf(row);
	return tools.length > 0 && tools.every((tool) => toolAccessOf(row.toolAccess, tool) === "off");
}

/**
 * Whether calls through the connector can be made: always for a secret,
 * after its sign-in for OAuth, and once its app is installed for GitHub.
 */
export function isSignedIn(
	row: Pick<ConnectorRow, "authKind" | "oauthEncrypted" | "settings">,
	cipher: Secrets.Interface,
): boolean {
	if (row.settings?.kind === "github") return gitHubInstalled(row.settings);
	return row.authKind === "header" || decryptOauthRecord(row, cipher)?.tokens !== undefined;
}

/** Whether a GitHub connector's app is installed on an account. */
function gitHubInstalled(settings: GitHubConnectorSettings): boolean {
	return settings.installationId !== null;
}

/** Whether the connector's tokens were refused with nobody there to sign in again, and nobody has since. */
export function signInExpired(
	row: Pick<ConnectorRow, "authKind" | "oauthEncrypted">,
	cipher: Secrets.Interface,
): boolean {
	return (
		row.authKind === "oauth" && decryptOauthRecord(row, cipher)?.signInRejectedAt !== undefined
	);
}

/** What the OAuth client has learnt and been issued for the connector, unsealed. */
function decryptOauthRecord(
	row: Pick<ConnectorRow, "oauthEncrypted">,
	cipher: Secrets.Interface,
): OAuthRecord | undefined {
	return row.oauthEncrypted
		? (JSON.parse(cipher.decrypt(row.oauthEncrypted)) as OAuthRecord)
		: undefined;
}

/**
 * Whether `changes` change how the connector is reached: its address or the
 * secret sent there, which a test or the tools it listed no longer speak for.
 */
export function changesReach(changes: Pick<ConnectorUpdate, "url" | "secret" | "secretHeader">) {
	return (
		changes.url !== undefined || changes.secret !== undefined || changes.secretHeader !== undefined
	);
}
