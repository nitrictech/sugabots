import type { Connection } from "@sugabots/contracts";
import { and, asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import type { Credentials } from "../../credentials/credentials.ts";
import { query } from "../../database/database.ts";
import { type ConnectionRow, connection, user } from "../../database/schema.ts";
import { configurationStatus } from "../tested-configuration.ts";
import { isSignedIn } from "./connection-repository.ts";
import { toolAccessOf } from "./tool-access.ts";

/** The pod's connections, oldest first. `cipher` opens an OAuth record to tell whether it is signed in. */
export const connectionsIn = (workspaceId: string, podId: string, cipher: Credentials.Interface) =>
	query((db) =>
		db
			.select({ row: connection, connectedBy: user.name })
			.from(connection)
			.leftJoin(user, eq(user.id, connection.createdById))
			.where(and(eq(connection.workspaceId, workspaceId), eq(connection.podId, podId)))
			.orderBy(asc(connection.createdAt)),
	).pipe(Effect.map((rows) => rows.map((found) => toConnection(found, cipher))));

/** One of the pod's connections, or nothing. */
export const connectionIn = (
	workspaceId: string,
	podId: string,
	connectionId: string,
	cipher: Credentials.Interface,
) =>
	query((db) =>
		db
			.select({ row: connection, connectedBy: user.name })
			.from(connection)
			.leftJoin(user, eq(user.id, connection.createdById))
			.where(
				and(
					eq(connection.id, connectionId),
					eq(connection.workspaceId, workspaceId),
					eq(connection.podId, podId),
				),
			)
			.limit(1),
	).pipe(Effect.map(([found]) => found && toConnection(found, cipher)));

function toConnection(
	{ row, connectedBy }: { row: ConnectionRow; connectedBy: string | null },
	cipher: Credentials.Interface,
): Connection {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		podId: row.podId,
		name: row.name,
		handle: row.handle,
		url: row.url,
		auth: row.authKind,
		signedIn: isSignedIn(row, cipher),
		secretHeader: row.secretHeader,
		hasSecret: row.secretEncrypted !== null,
		status: configurationStatus({
			missingKey: false,
			lastTestedAt: row.lastTestedAt,
			lastTestError: row.lastTestError,
		}),
		tools: row.tools.map((tool) => ({
			...tool,
			access: toolAccessOf(row.toolAccess, tool),
		})),
		lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
		lastTestError: row.lastTestError,
		connectedBy,
		createdAt: row.createdAt.toISOString(),
	};
}
