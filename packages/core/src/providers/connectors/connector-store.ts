export { ConnectorNameTaken, UnknownConnectorTool } from "@sugabots/contracts/errors/connectors";
export * as ConnectorStore from "./connector-store.ts";

import { createHash } from "node:crypto";
import type { ConnectorTool, ConnectorUpdate, NewConnector } from "@sugabots/contracts";
import { handleFromName } from "@sugabots/contracts";
import {
	ConnectorAddressChanged,
	ConnectorNameTaken,
	ConnectorNotFound,
	UnknownConnectorTool,
} from "@sugabots/contracts/errors/connectors";
import type { UserText } from "@sugabots/errors";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";
import { query, queryCatching, serviceOperations, transaction } from "../../database/database.ts";
import { isUniqueViolation } from "../../database/errors.ts";
import {
	type ConnectorRow,
	connector,
	type GitHubConnectorRepository,
	type GitHubConnectorSettings,
	projectBot,
	projectBotConnector,
	type ToolAccess,
} from "../../database/schema.ts";
import type { MemberSession } from "../../principal.ts";
import { Secrets } from "../../secrets/secrets.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { inWorkspaceUnderMembershipLock } from "../../workspaces/membership/member-reads.ts";
import { changesAddress, stillConfiguredAs } from "../tested-configuration.ts";
import { type AugmentationTool, augmentConnectorTools } from "./augmentations.ts";
import type { ConnectorTarget } from "./connector-target.ts";
import { GITHUB_CONNECTOR_TOOLS } from "./github/github-tools.ts";
import { HTTP_CONNECTOR_TOOLS } from "./http-tools.ts";
import type { OAuthRecord } from "./oauth.ts";
import { toolAccessOf } from "./tool-access.ts";

export const OAUTH_EXCHANGE_CLAIM_MS = 30_000;

/**
 * The only writer of `connector`: the MCP servers, HTTP endpoints and GitHub
 * apps each project is connected to, the MCP servers' sealed secrets and OAuth
 * records, and the apps' sealed credentials. Also of `project_bot_connector`:
 * which of a bot's own connectors are on in the other projects it is in.
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
	 * account is their own; answers whether it was recorded. An installation
	 * that is a member's is recorded only while they are in the workspace, read
	 * under its membership lock, so one that lands during their removal waits
	 * for it and is refused, or is forgotten by it.
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
	readonly switchOff: (
		workspaceId: string,
		projectId: string,
		connectorId: string,
	) => Effect.Effect<Pick<ConnectorRow, "id" | "name" | "enabled" | "kind"> | undefined>;
	readonly remove: (
		workspaceId: string,
		projectId: string,
		connectorId: string,
	) => Effect.Effect<boolean>;
	/**
	 * Turns the bot `botId`'s own connector `connectorId` on in the project
	 * `projectId` for the address numbered `addressRevision`,
	 * failing with `ConnectorAddressChanged` once the connector has another;
	 * or off. The caller has proved the connector is the bot's and the bot is
	 * in the project.
	 */
	readonly setOnInProject: (input: {
		readonly workspaceId: string;
		readonly projectId: string;
		readonly botId: string;
		readonly connectorId: string;
		readonly on: boolean;
		readonly addressRevision?: number | undefined;
	}) => Effect.Effect<void, ConnectorAddressChanged | ConnectorNotFound>;
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
	readonly claimOauthExchange: (
		workspaceId: string,
		connectorId: string,
		serverUrl: string,
	) => Effect.Effect<OAuthExchangeClaim | "busy" | undefined>;
	readonly releaseOauthExchange: (
		workspaceId: string,
		connectorId: string,
		claim: OAuthExchangeClaim,
	) => Effect.Effect<void>;
	/** What the OAuth client has learnt and been issued, unsealed. */
	readonly oauthRecord: (
		workspaceId: string,
		connectorId: string,
	) => Effect.Effect<OAuthRecord | undefined>;
	/**
	 * The connector's OAuth record, unsealed, and the version it was read at,
	 * which a save built from it names; undefined for no such connector.
	 */
	readonly readOauthRecord: (
		workspaceId: string,
		connectorId: string,
		serverUrl?: string,
	) => Effect.Effect<{ record: OAuthRecord | undefined; version: OAuthVersion } | undefined>;
	/**
	 * Seals the record; its `state` is also kept in the clear so a callback can
	 * find the row. A record without tokens is signed out. Answers the version
	 * it saved, or undefined when it was refused:
	 *
	 * - a sign-in's tokens are saved only while the member who finished it is
	 *   in the workspace, read under its membership lock, so one that finishes
	 *   during their removal waits for it and is refused, or is signed out by it;
	 * - anything else, such as refreshed tokens or the start of a sign-in, is
	 *   saved only while the record is still the version it was built from, so
	 *   nothing read before a sign-out writes the signed-out tokens back.
	 */
	readonly saveOauthRecord: (
		workspaceId: string,
		connectorId: string,
		record: OAuthRecord,
		save: OAuthSave,
	) => Effect.Effect<string | undefined>;
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
	readonly byOauthState: (
		state: string,
		session: MemberSession,
	) => Effect.Effect<
		| {
				workspaceId: string;
				projectId: string;
				connectorId: string;
		  }
		| undefined
	>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ConnectorStore",
) {
	declare readonly [Tier]: "process";
}

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
				transaction(
					Effect.gen(function* () {
						if (
							installedById !== null &&
							!(yield* inWorkspaceUnderMembershipLock(workspaceId, installedById))
						) {
							return false;
						}
						return yield* recordInstallation(workspaceId, connectorId, {
							installationId,
							account,
							installedById,
						});
					}),
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
						const configurationChanged =
							changes.name !== undefined || changes.enabled !== undefined || connectorChanged;
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
										enabled: changes.enabled,
										handle: changes.name === undefined ? undefined : handleFromName(changes.name),
										url: changes.url,
										addressRevision: moved ? sql`${connector.addressRevision} + 1` : undefined,
										secretHeader: changes.secretHeader,
										secretEncrypted: changes.secret
											? cipher.encrypt(changes.secret)
											: changes.secret === null || moved
												? null
												: undefined,
										// The OAuth client was registered with, and its tokens issued
										// by, the old address's authorization server.
										oauthEncrypted: moved ? null : undefined,
										oauthExchangeId: moved ? null : undefined,
										oauthExchangeUntil: moved ? null : undefined,
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

		switchOff: (workspaceId, projectId, connectorId) =>
			operation(
				"switchOff",
				query((db) =>
					db
						.update(connector)
						.set({
							enabled: false,
							configurationRevision: sql`${connector.configurationRevision} + 1`,
						})
						.where(
							and(
								eq(connector.workspaceId, workspaceId),
								eq(connector.projectId, projectId),
								eq(connector.id, connectorId),
							),
						)
						.returning({
							id: connector.id,
							name: connector.name,
							enabled: connector.enabled,
							kind: connector.kind,
						}),
				).pipe(Effect.map(([row]) => row)),
			),

		setOnInProject: ({ workspaceId, projectId, botId, connectorId, on, addressRevision }) =>
			operation(
				"setOnInProject",
				transaction(
					Effect.gen(function* () {
						// The connector before its row in the project, the order deleting the
						// connector takes them in; shared, so its address can't change until
						// this commits.
						const [current] = yield* query((db) =>
							db
								.select({ addressRevision: connector.addressRevision })
								.from(connector)
								.where(and(eq(connector.id, connectorId), eq(connector.workspaceId, workspaceId)))
								.for("share"),
						);
						if (!current) return;
						if (!on) {
							yield* query((db) =>
								db
									.delete(projectBotConnector)
									.where(
										and(
											eq(projectBotConnector.projectId, projectId),
											eq(projectBotConnector.connectorId, connectorId),
										),
									),
							);
							return;
						}
						if (current.addressRevision !== addressRevision)
							return yield* new ConnectorAddressChanged();
						const [placed] = yield* query((db) =>
							db
								.select({ botId: projectBot.botId })
								.from(projectBot)
								.where(and(eq(projectBot.projectId, projectId), eq(projectBot.botId, botId)))
								.for("key share"),
						);
						if (!placed) return yield* new ConnectorNotFound();
						const turnedOn = { botId, addressRevision };
						yield* query((db) =>
							db
								.insert(projectBotConnector)
								.values({ workspaceId, projectId, connectorId, ...turnedOn })
								.onConflictDoUpdate({
									target: [projectBotConnector.projectId, projectBotConnector.connectorId],
									set: turnedOn,
								}),
						);
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
					const tools = "tools" in outcome ? outcome.tools : undefined;
					yield* query((db) =>
						db
							.update(connector)
							.set({
								lastTestedAt: now,
								lastTestError: "error" in outcome ? outcome.error : null,
								tools,
								configurationRevision:
									tools === undefined
										? undefined
										: sql`case when ${connector.tools} is distinct from ${JSON.stringify(tools)}::jsonb
										then ${connector.configurationRevision} + 1 else ${connector.configurationRevision} end`,
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
						const used = rows.filter((row) => row.enabled && !everyToolOff(row));
						return {
							targets: used.filter((row) => isSignedIn(row, cipher)).map(toTarget),
							signInExpired: used
								.filter((row) => signInExpired(row, cipher))
								.map(({ id, handle, configurationRevision }) => ({
									connectorId: id,
									handle,
									configurationRevision,
								})),
							installedUrls: rows.map(({ url }) => url),
						};
					}),
				),
			),

		claimOauthExchange: (workspaceId, connectorId, serverUrl) =>
			operation(
				"claimOauthExchange",
				Effect.gen(function* () {
					const target = and(
						eq(connector.id, connectorId),
						eq(connector.workspaceId, workspaceId),
						eq(connector.authKind, "oauth"),
						eq(connector.url, serverUrl),
					);
					const [claimed] = yield* query((db) =>
						db
							.update(connector)
							.set({
								oauthExchangeId: sql`uuidv7()`,
								oauthExchangeUntil: sql`clock_timestamp() + ${OAUTH_EXCHANGE_CLAIM_MS} * interval '1 millisecond'`,
								updatedAt: sql`${connector.updatedAt}`,
							})
							.where(
								and(
									target,
									sql`coalesce(${connector.oauthExchangeUntil}, '-infinity') <= clock_timestamp()`,
								),
							)
							.returning({ id: connector.oauthExchangeId }),
					);
					if (claimed?.id) return { id: claimed.id };
					const [found] = yield* query((db) =>
						db.select({ id: connector.id }).from(connector).where(target),
					);
					return found ? "busy" : undefined;
				}),
			),

		releaseOauthExchange: (workspaceId, connectorId, claim) =>
			operation(
				"releaseOauthExchange",
				query((db) =>
					db
						.update(connector)
						.set({
							oauthExchangeId: null,
							oauthExchangeUntil: null,
							updatedAt: sql`${connector.updatedAt}`,
						})
						.where(
							and(
								eq(connector.id, connectorId),
								eq(connector.workspaceId, workspaceId),
								eq(connector.oauthExchangeId, claim.id),
							),
						),
				).pipe(Effect.asVoid),
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

		readOauthRecord: (workspaceId, connectorId, serverUrl) =>
			operation(
				"readOauthRecord",
				query((db) =>
					db
						.select({ oauthEncrypted: connector.oauthEncrypted })
						.from(connector)
						.where(
							and(
								eq(connector.id, connectorId),
								eq(connector.workspaceId, workspaceId),
								serverUrl === undefined ? undefined : eq(connector.url, serverUrl),
							),
						)
						.limit(1),
				).pipe(
					Effect.map(
						([row]) =>
							row && {
								record: decryptOauthRecord(row, cipher),
								version: row.oauthEncrypted,
							},
					),
				),
			),

		saveOauthRecord: (workspaceId, connectorId, record, save) =>
			operation(
				"saveOauthRecord",
				transaction(
					Effect.gen(function* () {
						if (
							save.kind === "signIn" &&
							!(yield* inWorkspaceUnderMembershipLock(workspaceId, save.signedInById))
						) {
							return undefined;
						}
						const sealed = cipher.encrypt(JSON.stringify(record));
						const signer = save.kind === "signIn" ? save.signedInById : undefined;
						const [saved] = yield* query((db) =>
							db
								.update(connector)
								.set({
									oauthEncrypted: sealed,
									oauthState:
										record.state && record.startedBySessionId ? hashOAuthState(record.state) : null,
									signedInById: record.tokens === undefined ? null : signer,
									configurationRevision: record.state
										? sql`${connector.configurationRevision} + 1`
										: undefined,
								})
								.where(
									and(
										eq(connector.id, connectorId),
										eq(connector.workspaceId, workspaceId),
										sql`${connector.oauthEncrypted} is not distinct from ${save.version}`,
										save.claim === undefined
											? undefined
											: and(
													eq(connector.oauthExchangeId, save.claim.id),
													sql`${connector.oauthExchangeUntil} > clock_timestamp()`,
												),
									),
								)
								.returning({ id: connector.id }),
						);
						return saved ? sealed : undefined;
					}),
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
							oauthExchangeId: null,
							oauthExchangeUntil: null,
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
										addressRevision: addressRevisionAfter(gitHubAppUrl(settings.slug)),
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

		byOauthState: (state, session) =>
			operation(
				"byOauthState",
				query((db) =>
					db
						.select()
						.from(connector)
						.where(eq(connector.oauthState, hashOAuthState(state)))
						.limit(1),
				).pipe(
					Effect.map(([row]) => {
						if (!row) return undefined;
						const record = decryptOauthRecord(row, cipher);
						if (
							record?.state !== state ||
							record.startedByMemberId !== session.member ||
							record.startedBySessionId !== session.session
						)
							return undefined;
						return { workspaceId: row.workspaceId, projectId: row.projectId, connectorId: row.id };
					}),
				),
			),
	});
});

export const layer = processLayer(Layer.effect(Service, make));

const hashOAuthState = (state: string) => createHash("sha256").update(state).digest("hex");

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
	/** Connectors that offer nothing until someone signs in again. */
	signInExpired: Pick<ConnectorTarget, "connectorId" | "handle" | "configurationRevision">[];
	/** Addresses of all of the project's MCP and HTTP connectors, including those switched off. */
	installedUrls: string[];
}

/**
 * What a test found: the server's tools, absent for a connector whose tools
 * are Sugabots' own, or why it could not be asked.
 */
type TestOutcome = { tools?: ConnectorTool[] } | { error: UserText };

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

/**
 * The version of a connector's OAuth record a save was built from: its sealed
 * value as read, which sealing again never repeats, or null when it had none.
 */
export type OAuthVersion = string | null;

export interface OAuthExchangeClaim {
	readonly id: string;
}

/** How a save of a connector's OAuth record may land (see `saveOauthRecord`). */
type OAuthSave = {
	readonly version: OAuthVersion;
	readonly claim?: OAuthExchangeClaim;
} & ({ readonly kind: "signIn"; readonly signedInById: string } | { readonly kind: "since" });

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

/** The connector's address revision once its address is `url`: one more if that is a change. */
const addressRevisionAfter = (url: string) =>
	sql`${connector.addressRevision} + case when ${connector.url} = ${url} then 0 else 1 end`;

/** Records the installation on the GitHub connector, answering whether there was one to record it on. */
const recordInstallation = (
	workspaceId: string,
	connectorId: string,
	{
		installationId,
		account,
		installedById,
	}: { installationId: number; account: string; installedById: string | null },
) =>
	query((db) =>
		db
			.update(connector)
			.set({
				url: `https://github.com/${account}`,
				addressRevision: addressRevisionAfter(`https://github.com/${account}`),
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
	).pipe(Effect.map((rows) => rows.length > 0));
