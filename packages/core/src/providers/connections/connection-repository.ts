export * as ConnectionRepository from "./connection-repository.ts";

import type { ConnectionTool, ConnectionUpdate, NewConnection } from "@sugabots/contracts";
import { handleFromName } from "@sugabots/contracts";
import { type UserText, userText } from "@sugabots/errors";
import { and, asc, eq, sql } from "drizzle-orm";
import { Context, Data, DateTime, Effect, Layer } from "effect";
import { Credentials } from "../../credentials/credentials.ts";
import { query, queryCatching, serviceOperations, transaction } from "../../database/database.ts";
import { isUniqueViolation } from "../../database/errors.ts";
import { type ConnectionRow, connection, type ToolAccess } from "../../database/schema.ts";
import type { UserFacing } from "../../user-message.ts";
import { stillConfiguredAs } from "../tested-configuration.ts";
import type { ConnectionTarget } from "./connection-target.ts";
import type { OAuthRecord } from "./oauth.ts";
import { toolAccessOf } from "./tool-access.ts";

/**
 * The only writer of `connection`: the MCP servers a pod's agents may use, and
 * their sealed secrets and OAuth records.
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
	 * The ones a turn may use. A connection still waiting on its sign-in offers
	 * nothing, and neither does one whose every listed tool is off, so a turn
	 * does not reach its server at all.
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
									.select({ names: listedToolNames })
									.from(connection)
									.where(inPod)
									.limit(1)
									.for("update"),
							);
							if (!current) return undefined;
							chosen = yield* choicesFor(current.names, changes);
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
						.where(and(eq(connection.workspaceId, workspaceId), eq(connection.podId, podId)))
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

/** Whether the server listed tools when last asked and every one of them is off. */
function everyToolOff(row: ConnectionRow): boolean {
	return (
		row.tools.length > 0 && row.tools.every((tool) => toolAccessOf(row.toolAccess, tool) === "off")
	);
}

/** Whether calls to the connection's server can be made: always for a secret, after its sign-in for OAuth. */
export function isSignedIn(
	row: Pick<ConnectionRow, "authKind" | "oauthEncrypted">,
	cipher: Credentials.Interface,
): boolean {
	return row.authKind === "header" || unsealOauthRecord(row, cipher)?.tokens !== undefined;
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
