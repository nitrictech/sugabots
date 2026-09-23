import type {
	Connection,
	ConnectionTool,
	ConnectionUpdate,
	NewConnection,
} from "@sugabots/contracts";
import { handleFromName } from "@sugabots/contracts";
import { and, asc, eq, sql } from "drizzle-orm";
import { Data, Effect } from "effect";
import { type Database, query, queryCatching } from "../../database/database.ts";
import { isUniqueViolation } from "../../database/errors.ts";
import { type ConnectionRow, connection, workspace } from "../../database/schema.ts";
import type { CredentialCipher } from "../model-providers/credentials.ts";
import type { OAuthRecord } from "./oauth.ts";

/** What it takes to call the server: where, and with which headers. */
export interface ConnectionTarget {
	connectionId: string;
	handle: string;
	url: string;
	/** `oauth` calls carry no header of ours: the SDK adds the tokens it holds. */
	auth: "header" | "oauth";
	headers: Record<string, string>;
	/** Whether tools that change things may be offered, not only read-only ones. */
	allowMutating: boolean;
	/** So a test result is recorded against the configuration it tested. */
	configurationUpdatedAt: Date;
	configurationRevision: number;
}

/** What a test found: the server's tools, or why it could not be asked. */
export type ConnectionTestOutcome = { tools: ConnectionTool[] } | { error: string };

export class ConnectionNameTaken extends Data.TaggedError("ConnectionNameTaken") {
	override get message() {
		return "A connection with that name already exists";
	}
}

/**
 * Reading and writing a pod's connections.
 *
 * `create` and `update` declare one failure: a name, and the handle made from
 * it, is unique per pod. `enabled` is not checked by `target`; a test is how
 * the pod owner decides whether to enable it.
 */
export interface ConnectionStore {
	list(workspaceId: string, podId: string): Effect.Effect<Connection[], never, Database>;
	get(
		workspaceId: string,
		podId: string,
		connectionId: string,
	): Effect.Effect<Connection | undefined, never, Database>;
	create(
		workspaceId: string,
		podId: string,
		userId: string,
		input: NewConnection,
	): Effect.Effect<Connection, ConnectionNameTaken, Database>;
	update(
		workspaceId: string,
		podId: string,
		connectionId: string,
		input: ConnectionUpdate,
	): Effect.Effect<Connection | undefined, ConnectionNameTaken, Database>;
	remove(
		workspaceId: string,
		podId: string,
		connectionId: string,
	): Effect.Effect<boolean, never, Database>;
	target(
		workspaceId: string,
		podId: string,
		connectionId: string,
	): Effect.Effect<ConnectionTarget | undefined, never, Database>;
	/** The enabled ones among these, for a turn: a connection switched off offers nothing. */
	targetsForPod(
		workspaceId: string,
		podId: string,
	): Effect.Effect<ConnectionTarget[], never, Database>;
	recordTest(
		workspaceId: string,
		connectionId: string,
		configurationUpdatedAt: Date,
		outcome: ConnectionTestOutcome,
	): Effect.Effect<void, never, Database>;
	/** What the OAuth client has learnt and been issued, unsealed. */
	oauthRecord(
		workspaceId: string,
		connectionId: string,
	): Effect.Effect<OAuthRecord | undefined, never, Database>;
	/** Seals the record; its `state` is also kept in the clear so a callback can find the row. */
	saveOauthRecord(
		workspaceId: string,
		connectionId: string,
		record: OAuthRecord,
	): Effect.Effect<void, never, Database>;
	/** The connection a sign-in callback belongs to, by the `state` it carries. */
	byOauthState(
		state: string,
	): Effect.Effect<
		{ workspaceId: string; workspaceSlug: string; podId: string; connectionId: string } | undefined,
		never,
		Database
	>;
}

export function connectionStore(cipher: CredentialCipher): ConnectionStore {
	const load = (workspaceId: string, podId: string, connectionId: string) =>
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
		).pipe(Effect.map(([row]) => row));
	const loadInWorkspace = (workspaceId: string, connectionId: string) =>
		query((db) =>
			db
				.select()
				.from(connection)
				.where(and(eq(connection.id, connectionId), eq(connection.workspaceId, workspaceId)))
				.limit(1),
		).pipe(Effect.map(([row]) => row));

	return {
		list: (workspaceId, podId) =>
			Effect.map(
				query((db) =>
					db
						.select()
						.from(connection)
						.where(and(eq(connection.workspaceId, workspaceId), eq(connection.podId, podId)))
						.orderBy(asc(connection.createdAt)),
				),
				(rows) => rows.map((row) => toConnection(row, cipher)),
			),

		get: (workspaceId, podId, connectionId) =>
			Effect.map(load(workspaceId, podId, connectionId), (row) => row && toConnection(row, cipher)),

		create: (workspaceId, podId, userId, input) =>
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
				return toConnection(inserted, cipher);
			}),

		update: (workspaceId, podId, connectionId, input) =>
			Effect.gen(function* () {
				const connectionChanged =
					input.url !== undefined || input.secretHeader !== undefined || input.secret !== undefined;
				const configurationChanged =
					input.name !== undefined ||
					connectionChanged ||
					input.enabled !== undefined ||
					input.allowMutating !== undefined;
				const [row] = yield* queryCatching(
					(db) =>
						db
							.update(connection)
							.set({
								name: input.name,
								handle: input.name === undefined ? undefined : handleFromName(input.name),
								url: input.url,
								secretHeader: input.secretHeader,
								secretEncrypted:
									input.secret === undefined
										? undefined
										: input.secret === null
											? null
											: cipher.encrypt(input.secret),
								enabled: input.enabled,
								allowMutating: input.allowMutating,
								configurationRevision: configurationChanged
									? sql`${connection.configurationRevision} + 1`
									: undefined,
								lastTestedAt: connectionChanged ? null : undefined,
								lastTestError: connectionChanged ? null : undefined,
							})
							.where(
								and(
									eq(connection.id, connectionId),
									eq(connection.workspaceId, workspaceId),
									eq(connection.podId, podId),
								),
							)
							.returning(),
					(failure) => (isUniqueViolation(failure) ? new ConnectionNameTaken() : undefined),
				);
				return row && toConnection(row, cipher);
			}),

		remove: (workspaceId, podId, connectionId) =>
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

		target: (workspaceId, podId, connectionId) =>
			Effect.map(load(workspaceId, podId, connectionId), (row) => row && toTarget(row, cipher)),

		targetsForPod: (workspaceId, podId) =>
			Effect.map(
				query((db) =>
					db
						.select()
						.from(connection)
						.where(
							and(
								eq(connection.workspaceId, workspaceId),
								eq(connection.podId, podId),
								eq(connection.enabled, true),
							),
						)
						.orderBy(asc(connection.createdAt)),
				),
				(rows) => rows.map((row) => toTarget(row, cipher)),
			),

		oauthRecord: (workspaceId, connectionId) =>
			Effect.map(
				loadInWorkspace(workspaceId, connectionId),
				(row) => row && unsealOauth(row, cipher),
			),

		saveOauthRecord: (workspaceId, connectionId, record) =>
			Effect.gen(function* () {
				const startsAuthorization = Boolean(record.state);
				yield* query((db) =>
					db
						.update(connection)
						.set({
							oauthEncrypted: cipher.encrypt(JSON.stringify(record)),
							oauthState: record.state || null,
							configurationRevision: startsAuthorization
								? sql`${connection.configurationRevision} + 1`
								: undefined,
						})
						.where(and(eq(connection.id, connectionId), eq(connection.workspaceId, workspaceId))),
				);
			}),

		byOauthState: (state) =>
			query((db) =>
				db
					.select({
						workspaceId: connection.workspaceId,
						workspaceSlug: workspace.slug,
						podId: connection.podId,
						connectionId: connection.id,
					})
					.from(connection)
					.innerJoin(workspace, eq(workspace.id, connection.workspaceId))
					.where(eq(connection.oauthState, state))
					.limit(1),
			).pipe(Effect.map(([row]) => row)),

		recordTest: (workspaceId, connectionId, configurationUpdatedAt, outcome) =>
			Effect.asVoid(
				query((db) =>
					db
						.update(connection)
						.set({
							lastTestedAt: new Date(),
							lastTestError: "error" in outcome ? outcome.error : null,
							tools: "tools" in outcome ? outcome.tools : undefined,
						})
						.where(
							and(
								eq(connection.id, connectionId),
								eq(connection.workspaceId, workspaceId),
								// Postgres stamps microseconds on insert, drizzle milliseconds on
								// update, and a Date has only milliseconds: compare at that.
								sqlMillis(configurationUpdatedAt),
							),
						),
				),
			),
	};
}

function sqlMillis(configurationUpdatedAt: Date) {
	return sql`date_trunc('milliseconds', ${connection.updatedAt}) = ${configurationUpdatedAt}`;
}

function toTarget(row: ConnectionRow, cipher: CredentialCipher): ConnectionTarget {
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
		allowMutating: row.allowMutating,
		configurationUpdatedAt: row.updatedAt,
		configurationRevision: row.configurationRevision,
	};
}

function unsealOauth(row: ConnectionRow, cipher: CredentialCipher): OAuthRecord | undefined {
	return row.oauthEncrypted
		? (JSON.parse(cipher.decrypt(row.oauthEncrypted)) as OAuthRecord)
		: undefined;
}

function toConnection(row: ConnectionRow, cipher: CredentialCipher): Connection {
	const hasSecret = row.secretEncrypted !== null;
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		podId: row.podId,
		name: row.name,
		handle: row.handle,
		url: row.url,
		auth: row.authKind,
		signedIn: row.authKind === "header" || unsealOauth(row, cipher)?.tokens !== undefined,
		secretHeader: row.secretHeader,
		hasSecret,
		enabled: row.enabled,
		allowMutating: row.allowMutating,
		status: row.lastTestedAt === null ? "untested" : row.lastTestError ? "error" : "connected",
		tools: row.tools,
		lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
		lastTestError: row.lastTestError,
		createdAt: row.createdAt.toISOString(),
	};
}
