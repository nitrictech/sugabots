export * as ConnectionRepository from "./connection-repository.ts";

import type { ConnectionTool, ConnectionUpdate, NewConnection } from "@sugabots/contracts";
import { handleFromName } from "@sugabots/contracts";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { Context, Data, DateTime, Effect, Layer } from "effect";
import { Credentials } from "../../credentials/credentials.ts";
import { query, queryCatching, serviceOperations } from "../../database/database.ts";
import { isUniqueViolation } from "../../database/errors.ts";
import { type ConnectionRow, connection } from "../../database/schema.ts";
import { Ids } from "../../ids/ids.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { stillConfiguredAs } from "../tested-configuration.ts";
import type { ConnectionTarget } from "./connection-target.ts";
import type { OAuthRecord } from "./oauth.ts";

/**
 * The only writer of `connection`: the MCP servers a pod's agents may use, and
 * their sealed secrets and OAuth records.
 *
 * A name, and the handle made from it, is unique per pod. `access` is not
 * checked by `target`: a connection that is off can still be tested before it
 * is turned on.
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
	) => Effect.Effect<ConnectionRow | undefined, ConnectionNameTaken>;
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
	/** The ones a turn may use: a connection that is off offers nothing. */
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
	const ids = yield* Ids.Service;
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
			access: row.access,
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
						// Nothing can be asked of a server before it is signed in to.
						access: oauth ? ("off" as const) : ("allow" as const),
					};
					const id = yield* ids.next;
					const [inserted] = yield* queryCatching(
						(db) =>
							db
								.insert(connection)
								.values({
									id,
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
				Effect.gen(function* () {
					const connectionChanged =
						changes.url !== undefined ||
						changes.secretHeader !== undefined ||
						changes.secret !== undefined;
					const configurationChanged =
						changes.name !== undefined || connectionChanged || changes.access !== undefined;
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
									access: changes.access,
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
					return row;
				}),
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
								ne(connection.access, "off"),
							),
						)
						.orderBy(asc(connection.createdAt)),
				).pipe(Effect.map((rows) => rows.map(toTarget))),
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
export type TestOutcome = { tools: ConnectionTool[] } | { error: UserMessage };

export class ConnectionNameTaken
	extends Data.TaggedError("ConnectionNameTaken")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`A connection with that name already exists in this pod`;
	}
}

/** What the OAuth client has learnt and been issued for the connection, unsealed. */
export function unsealOauthRecord(
	row: ConnectionRow,
	cipher: Credentials.Interface,
): OAuthRecord | undefined {
	return row.oauthEncrypted
		? (JSON.parse(cipher.decrypt(row.oauthEncrypted)) as OAuthRecord)
		: undefined;
}
