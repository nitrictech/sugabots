export * as ConnectionRepository from "./connection-repository.ts";

import type { ConnectionTool, ConnectionUpdate, NewConnection } from "@sugabots/contracts";
import { handleFromName } from "@sugabots/contracts";
import { type UserText, userText } from "@sugabots/errors";
import { and, asc, eq, sql } from "drizzle-orm";
import { Context, Data, DateTime, Effect, Layer } from "effect";
import { Credentials } from "../../credentials/credentials.ts";
import { query, queryCatching, serviceOperations, transaction } from "../../database/database.ts";
import { isUniqueViolation } from "../../database/errors.ts";
import {
	type ConnectionRow,
	connection,
	type GitHubConnectionRepository,
	type GitHubConnectionSettings,
	type ToolAccess,
} from "../../database/schema.ts";
import type { UserFacing } from "../../user-message.ts";
import { stillConfiguredAs } from "../tested-configuration.ts";
import type { ConnectionTarget } from "./connection-target.ts";
import { GITHUB_CONNECTION_TOOLS } from "./github/github-tools.ts";
import type { OAuthRecord } from "./oauth.ts";
import { toolAccessOf } from "./tool-access.ts";

/**
 * The only writer of `connection`: the MCP servers and GitHub apps a pod's
 * agents may use, the MCP servers' sealed secrets and OAuth records, and the
 * apps' sealed credentials.
 *
 * A name, and the handle made from it, is unique per pod. `target` does not
 * look at what the pod's bots may do with the tools: a connection whose tools
 * are all off can still be tested.
 *
 * What a person chooses for a tool is not a change of configuration: it
 * leaves `configurationRevision`, and the approvals made under it, alone.
 * An approved call to a tool turned off since is refused when it would run.
 */
export interface Interface {
	readonly create: (
		workspaceId: string,
		podId: string,
		userId: string,
		input: NewConnection,
	) => Effect.Effect<ConnectionRow, ConnectionNameTaken>;
	/**
	 * Gives the pod a GitHub connection to the app made for it, `id`. It
	 * waits on `installed` before it is signed in.
	 */
	readonly createGitHub: (
		workspaceId: string,
		podId: string,
		userId: string,
		input: {
			id: string;
			app: Pick<GitHubConnectionSettings, "appId" | "slug" | "owner">;
			appCredentialEncrypted: string;
		},
	) => Effect.Effect<ConnectionRow, ConnectionNameTaken>;
	/**
	 * Records the account the connection's app was installed on, or installed
	 * on again; answers whether the connection is still there.
	 */
	readonly installed: (
		workspaceId: string,
		connectionId: string,
		installation: { installationId: number; account: string },
	) => Effect.Effect<boolean>;
	/**
	 * Changes a GitHub connection's repositories to what `change` makes of
	 * them, with the connection locked meanwhile, so two changes made at once
	 * both land. A change to which repositories it has, not only to how they
	 * are written, is a change of configuration. Answers the repositories as
	 * they now are, or undefined for no such GitHub connection.
	 */
	readonly changeGitHubRepositories: (
		workspaceId: string,
		connectionId: string,
		change: (
			repositories: readonly GitHubConnectionRepository[],
		) => readonly GitHubConnectionRepository[],
	) => Effect.Effect<readonly GitHubConnectionRepository[] | undefined>;
	/** Counts a change to what a connection's tools work on as a change of configuration. */
	readonly reconfigured: (workspaceId: string, connectionId: string) => Effect.Effect<void>;
	readonly update: (
		workspaceId: string,
		podId: string,
		connectionId: string,
		changes: ConnectionUpdate,
	) => Effect.Effect<ConnectionRow | undefined, ConnectionNameTaken | UnknownConnectionTool>;
	readonly remove: (
		workspaceId: string,
		podId: string,
		connectionId: string,
	) => Effect.Effect<boolean>;
	/**
	 * Records what a test of the configuration last updated at `testedAt`
	 * found, unless the connection has been reconfigured since.
	 */
	readonly recordTest: (
		workspaceId: string,
		connectionId: string,
		testedAt: Date,
		outcome: TestOutcome,
	) => Effect.Effect<void>;
	readonly target: (
		workspaceId: string,
		podId: string,
		connectionId: string,
	) => Effect.Effect<ConnectionTarget | undefined>;
	/**
	 * The MCP servers a turn may use. A connection still waiting on its
	 * sign-in offers nothing, and neither does one whose every listed tool is
	 * off, so a turn does not reach its server at all.
	 */
	readonly targetsForPod: (workspaceId: string, podId: string) => Effect.Effect<ConnectionTarget[]>;
	/** What the OAuth client has learnt and been issued, unsealed. */
	readonly oauthRecord: (
		workspaceId: string,
		connectionId: string,
	) => Effect.Effect<OAuthRecord | undefined>;
	/** Seals the record; its `state` is also kept in the clear so a callback can find the row. */
	readonly saveOauthRecord: (
		workspaceId: string,
		connectionId: string,
		record: OAuthRecord,
	) => Effect.Effect<void>;
	/**
	 * The connection a sign-in callback belongs to, by the `state` it carries,
	 * and who started that sign-in, if anybody did.
	 */
	readonly byOauthState: (state: string) => Effect.Effect<
		| {
				workspaceId: string;
				podId: string;
				connectionId: string;
				startedByUserId: string | undefined;
		  }
		| undefined
	>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ConnectionRepository",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ConnectionRepository");
	const cipher = yield* Credentials.Service;

	const toTarget = (row: ConnectionRow): ConnectionTarget => {
		const headers: Record<string, string> = {};
		if (row.secretHeader && row.secretEncrypted) {
			headers[row.secretHeader] = cipher.decrypt(row.secretEncrypted);
		}
		return {
			connectionId: row.id,
			handle: row.handle,
			url: row.url,
			auth: row.authKind,
			headers,
			toolAccess: row.toolAccess,
			configurationUpdatedAt: row.updatedAt,
			configurationRevision: row.configurationRevision,
		};
	};

	return Service.of({
		create: (workspaceId, podId, userId, input) =>
			operation(
				"create",
				Effect.gen(function* () {
					const oauth = input.auth === "oauth";
					const values = {
						name: input.name,
						url: input.url,
						authKind: oauth ? ("oauth" as const) : ("header" as const),
						secretHeader: oauth ? null : (input.secretHeader ?? null),
						secretEncrypted: !oauth && input.secret ? cipher.encrypt(input.secret) : null,
					};
					const [inserted] = yield* queryCatching(
						(db) =>
							db
								.insert(connection)
								.values({
									workspaceId,
									podId,
									createdById: userId,
									handle: handleFromName(values.name),
									...values,
								})
								.returning(),
						(failure) => (isUniqueViolation(failure) ? new ConnectionNameTaken() : undefined),
					);
					if (!inserted) {
						return yield* Effect.die(new Error("Connection insert returned no row"));
					}
					return inserted;
				}),
			),

		createGitHub: (workspaceId, podId, userId, input) =>
			operation(
				"createGitHub",
				Effect.gen(function* () {
					const name = "GitHub";
					const testedAt = yield* DateTime.nowAsDate;
					const [inserted] = yield* queryCatching(
						(db) =>
							db
								.insert(connection)
								.values({
									workspaceId,
									podId,
									createdById: userId,
									kind: "github",
									name,
									handle: handleFromName(name),
									id: input.id,
									url: `https://github.com/apps/${input.app.slug}`,
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
						(failure) => (isUniqueViolation(failure) ? new ConnectionNameTaken() : undefined),
					);
					if (!inserted) {
						return yield* Effect.die(new Error("Connection insert returned no row"));
					}
					return inserted;
				}),
			),

		installed: (workspaceId, connectionId, { installationId, account }) =>
			operation(
				"installed",
				Effect.map(
					query((db) =>
						db
							.update(connection)
							.set({
								url: `https://github.com/${account}`,
								// Merged in SQL, so the app's own settings are kept as they are.
								settings: sql`${connection.settings} || ${JSON.stringify({ installationId, account })}::jsonb`,
								configurationRevision: sql`${connection.configurationRevision} + 1`,
							})
							.where(
								and(
									eq(connection.id, connectionId),
									eq(connection.workspaceId, workspaceId),
									eq(connection.kind, "github"),
								),
							)
							.returning({ id: connection.id }),
					),
					(rows) => rows.length > 0,
				),
			),

		changeGitHubRepositories: (workspaceId, connectionId, change) =>
			operation(
				"changeGitHubRepositories",
				transaction(
					Effect.gen(function* () {
						const where = and(
							eq(connection.id, connectionId),
							eq(connection.workspaceId, workspaceId),
							eq(connection.kind, "github"),
						);
						const [row] = yield* query((db) =>
							db
								.select({ settings: connection.settings })
								.from(connection)
								.where(where)
								.limit(1)
								.for("update"),
						);
						const settings = row?.settings;
						if (!settings) return undefined;
						const before = settings.repositories;
						const after = change(before);
						const ids = (repositories: readonly GitHubConnectionRepository[]) =>
							repositories
								.map((one) => one.id)
								.sort((a, b) => a - b)
								.join();
						yield* query((db) =>
							db
								.update(connection)
								.set({
									settings: { ...settings, repositories: after },
									...(ids(before) === ids(after)
										? {}
										: { configurationRevision: sql`${connection.configurationRevision} + 1` }),
								})
								.where(where),
						);
						return after;
					}),
				),
			),

		reconfigured: (workspaceId, connectionId) =>
			operation(
				"reconfigured",
				query((db) =>
					db
						.update(connection)
						.set({ configurationRevision: sql`${connection.configurationRevision} + 1` })
						.where(and(eq(connection.id, connectionId), eq(connection.workspaceId, workspaceId))),
				),
			),

		update: (workspaceId, podId, connectionId, changes) =>
			operation(
				"update",
				transaction(
					Effect.gen(function* () {
						const inPod = and(
							eq(connection.id, connectionId),
							eq(connection.workspaceId, workspaceId),
							eq(connection.podId, podId),
						);
						const connectionChanged =
							changes.url !== undefined ||
							changes.secretHeader !== undefined ||
							changes.secret !== undefined;
						const configurationChanged = changes.name !== undefined || connectionChanged;
						let chosen: ToolAccess | undefined;
						if (changes.access !== undefined || changes.toolAccess !== undefined) {
							const [current] = yield* query((db) =>
								db
									.select({ kind: connection.kind, names: listedToolNames })
									.from(connection)
									.where(inPod)
									.limit(1)
									.for("update"),
							);
							if (!current) return undefined;
							const names =
								current.kind === "github"
									? GITHUB_CONNECTION_TOOLS.map((tool) => tool.name)
									: current.names;
							chosen = yield* choicesFor(names, changes);
						}
						const [row] = yield* queryCatching(
							(db) =>
								db
									.update(connection)
									.set({
										name: changes.name,
										handle: changes.name === undefined ? undefined : handleFromName(changes.name),
										url: changes.url,
										secretHeader: changes.secretHeader,
										secretEncrypted:
											changes.secret === undefined
												? undefined
												: changes.secret === null
													? null
													: cipher.encrypt(changes.secret),
										toolAccess: chosen
											? sql`${connection.toolAccess} || ${JSON.stringify(chosen)}::jsonb`
											: undefined,
										configurationRevision: configurationChanged
											? sql`${connection.configurationRevision} + 1`
											: undefined,
										lastTestedAt: connectionChanged ? null : undefined,
										lastTestError: connectionChanged ? null : undefined,
									})
									.where(inPod)
									.returning(),
							(failure) => (isUniqueViolation(failure) ? new ConnectionNameTaken() : undefined),
						);
						return row;
					}),
				),
			),

		remove: (workspaceId, podId, connectionId) =>
			operation(
				"remove",
				query((db) =>
					db
						.delete(connection)
						.where(
							and(
								eq(connection.id, connectionId),
								eq(connection.workspaceId, workspaceId),
								eq(connection.podId, podId),
							),
						)
						.returning({ id: connection.id }),
				).pipe(Effect.map((deleted) => deleted.length > 0)),
			),

		recordTest: (workspaceId, connectionId, testedAt, outcome) =>
			operation(
				"recordTest",
				Effect.gen(function* () {
					const now = yield* DateTime.nowAsDate;
					yield* query((db) =>
						db
							.update(connection)
							.set({
								lastTestedAt: now,
								lastTestError: "error" in outcome ? outcome.error : null,
								tools: "tools" in outcome ? outcome.tools : undefined,
							})
							.where(
								and(
									eq(connection.id, connectionId),
									eq(connection.workspaceId, workspaceId),
									stillConfiguredAs(connection.updatedAt, testedAt),
								),
							),
					);
				}),
			),

		target: (workspaceId, podId, connectionId) =>
			operation(
				"target",
				query((db) =>
					db
						.select()
						.from(connection)
						.where(
							and(
								eq(connection.id, connectionId),
								eq(connection.workspaceId, workspaceId),
								eq(connection.podId, podId),
							),
						)
						.limit(1),
				).pipe(Effect.map(([row]) => row && toTarget(row))),
			),

		targetsForPod: (workspaceId, podId) =>
			operation(
				"targetsForPod",
				query((db) =>
					db
						.select()
						.from(connection)
						.where(
							and(
								eq(connection.workspaceId, workspaceId),
								eq(connection.podId, podId),
								// Other kinds' tools are Sugabots' own, with no server to reach.
								eq(connection.kind, "mcp"),
							),
						)
						.orderBy(asc(connection.createdAt)),
				).pipe(
					Effect.map((rows) =>
						rows
							.filter((row) => isSignedIn(row, cipher) && !everyToolOff(row))
							.map((row) => toTarget(row)),
					),
				),
			),

		oauthRecord: (workspaceId, connectionId) =>
			operation(
				"oauthRecord",
				query((db) =>
					db
						.select()
						.from(connection)
						.where(and(eq(connection.id, connectionId), eq(connection.workspaceId, workspaceId)))
						.limit(1),
				).pipe(Effect.map(([row]) => row && unsealOauthRecord(row, cipher))),
			),

		saveOauthRecord: (workspaceId, connectionId, record) =>
			operation(
				"saveOauthRecord",
				query((db) =>
					db
						.update(connection)
						.set({
							oauthEncrypted: cipher.encrypt(JSON.stringify(record)),
							oauthState: record.state || null,
							configurationRevision: record.state
								? sql`${connection.configurationRevision} + 1`
								: undefined,
						})
						.where(and(eq(connection.id, connectionId), eq(connection.workspaceId, workspaceId))),
				),
			),

		byOauthState: (state) =>
			operation(
				"byOauthState",
				query((db) =>
					db.select().from(connection).where(eq(connection.oauthState, state)).limit(1),
				).pipe(
					Effect.map(
						([row]) =>
							row && {
								workspaceId: row.workspaceId,
								podId: row.podId,
								connectionId: row.id,
								startedByUserId: unsealOauthRecord(row, cipher)?.startedByUserId,
							},
					),
				),
			),
	});
});

export const layer = Layer.effect(Service, make);

/** What a test found: the server's tools, or why it could not be asked. */
export type TestOutcome = { tools: ConnectionTool[] } | { error: UserText };

export class ConnectionNameTaken
	extends Data.TaggedError("ConnectionNameTaken")
	implements UserFacing
{
	get userMessage() {
		return userText`A connection with that name already exists in this pod`;
	}
}

export class UnknownConnectionTool
	extends Data.TaggedError("UnknownConnectionTool")<{ names: string[] }>
	implements UserFacing
{
	override get message() {
		return `The connection does not list ${this.names.join(", ")}`;
	}

	get userMessage() {
		return userText`The connection no longer lists some of those tools. Check the connection to refresh them.`;
	}
}

/** The names of the tools the server listed when last asked, leaving their descriptions in the database. */
const listedToolNames = sql<string[]>`jsonb_path_query_array(${connection.tools}, '$[*].name')`;

/**
 * The choices `changes` makes: `access` for every tool the server listed, or
 * `toolAccess` for the tools it names, each of which must be listed.
 */
function choicesFor(
	listed: readonly string[],
	changes: Pick<ConnectionUpdate, "access" | "toolAccess">,
): Effect.Effect<ToolAccess, UnknownConnectionTool> {
	const { access, toolAccess = {} } = changes;
	if (access) return Effect.succeed(Object.fromEntries(listed.map((name) => [name, access])));
	const known = new Set(listed);
	const unknown = Object.keys(toolAccess).filter((name) => !known.has(name));
	return unknown.length > 0
		? Effect.fail(new UnknownConnectionTool({ names: unknown }))
		: Effect.succeed(toolAccess);
}

/**
 * A connection's tools: an MCP server's as it listed them when last asked,
 * or GitHub's, which are Sugabots' own, as this version has them.
 */
export function toolsOf<Tool>(row: {
	kind: ConnectionRow["kind"];
	tools: readonly Tool[];
}): readonly (Tool | ConnectionTool)[] {
	return row.kind === "github" ? GITHUB_CONNECTION_TOOLS : row.tools;
}

/** Whether the connection has tools and every one of them is off. */
function everyToolOff(row: ConnectionRow): boolean {
	const tools = toolsOf(row);
	return tools.length > 0 && tools.every((tool) => toolAccessOf(row.toolAccess, tool) === "off");
}

/**
 * Whether calls through the connection can be made: always for a secret,
 * after its sign-in for OAuth, and once its app is installed for GitHub.
 */
export function isSignedIn(
	row: Pick<ConnectionRow, "authKind" | "oauthEncrypted" | "settings">,
	cipher: Credentials.Interface,
): boolean {
	if (row.settings?.kind === "github") return gitHubInstalled(row.settings);
	return row.authKind === "header" || unsealOauthRecord(row, cipher)?.tokens !== undefined;
}

/** Whether a GitHub connection's app is installed on an account. */
export function gitHubInstalled(settings: GitHubConnectionSettings): boolean {
	return settings.installationId !== null;
}

/** What the OAuth client has learnt and been issued for the connection, unsealed. */
export function unsealOauthRecord(
	row: Pick<ConnectionRow, "oauthEncrypted">,
	cipher: Credentials.Interface,
): OAuthRecord | undefined {
	return row.oauthEncrypted
		? (JSON.parse(cipher.decrypt(row.oauthEncrypted)) as OAuthRecord)
		: undefined;
}
