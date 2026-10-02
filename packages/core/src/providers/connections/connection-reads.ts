import type { Connection } from "@sugabots/contracts";
import { and, asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import type { Credentials } from "../../credentials/credentials.ts";
import { query } from "../../database/database.ts";
import { type ConnectionRow, connection } from "../../database/schema.ts";
import { configurationStatus } from "../tested-configuration.ts";
import { credentialOf, unsealOauthRecord } from "./connection-repository.ts";

/** The pod's connections, oldest first. `cipher` opens an OAuth record to tell whether it is signed in. */
export const connectionsIn = (workspaceId: string, podId: string, cipher: Credentials.Interface) =>
	query((db) =>
		db
			.select()
			.from(connection)
			.where(and(eq(connection.workspaceId, workspaceId), eq(connection.podId, podId)))
			.orderBy(asc(connection.createdAt)),
	).pipe(Effect.map((rows) => rows.map((row) => toConnection(row, cipher))));

/** One of the pod's connections, or nothing. */
export const connectionIn = (
	workspaceId: string,
	podId: string,
	connectionId: string,
	cipher: Credentials.Interface,
) =>
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
	).pipe(Effect.map(([row]) => row && toConnection(row, cipher)));

export function toConnection(row: ConnectionRow, cipher: Credentials.Interface): Connection {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		podId: row.podId,
		name: row.name,
		handle: row.handle,
		url: row.url,
		auth: row.authKind,
		signedIn: row.authKind === "header" || unsealOauthRecord(row, cipher)?.tokens !== undefined,
		secretHeader: row.secretHeader,
		hasSecret: row.secretEncrypted !== null,
		bearerToken: credentialOf(row, cipher) === "token",
		access: row.access,
		status: configurationStatus({
			missingKey: false,
			lastTestedAt: row.lastTestedAt,
			lastTestError: row.lastTestError,
		}),
		tools: row.tools,
		lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
		lastTestError: row.lastTestError,
		problem: row.lastTestProblem,
		problemDetail: row.lastTestDetail,
		createdAt: row.createdAt.toISOString(),
	};
}
