import {
	type Connection,
	type ConnectionTool,
	type ConnectionToolSetting,
	type ConnectionWithTools,
	toolAccessCountsOf,
} from "@sugabots/contracts";
import { and, asc, eq, getColumns, type SQL, sql } from "drizzle-orm";
import { Effect } from "effect";
import type { Credentials } from "../../credentials/credentials.ts";
import { query } from "../../database/database.ts";
import { type ConnectionRow, connection, user } from "../../database/schema.ts";
import { configurationStatus } from "../tested-configuration.ts";
import { isSignedIn } from "./connection-repository.ts";
import { toolAccessOf } from "./tool-access.ts";

/** A tool as the server described it, less its description. */
type ToolHints = Omit<ConnectionTool, "description">;

/** A connection's row with its tools' descriptions left in the database. */
type ListedRow = Omit<ConnectionRow, "tools"> & { tools: ToolHints[] };

const { tools: _, ...columnsBesideTools } = getColumns(connection);

/**
 * The server's tools without their descriptions, which can run to many
 * kilobytes each, in the order the server listed them.
 */
const toolsWithoutDescriptions = sql<ToolHints[]>`coalesce(
	(select jsonb_agg(listed.tool - 'description' order by listed.position)
	from jsonb_array_elements(${connection.tools}) with ordinality as listed(tool, position)),
	'[]'::jsonb
)`;

const listedRow = { ...columnsBesideTools, tools: toolsWithoutDescriptions };

/** The pod's connections, oldest first, each with how many tools are at each setting. */
export const connectionsIn = (workspaceId: string, podId: string, cipher: Credentials.Interface) =>
	listedRows(and(eq(connection.workspaceId, workspaceId), eq(connection.podId, podId))).pipe(
		Effect.map((rows) =>
			rows.map(({ row, connectedBy }) => toConnection(row, connectedBy, cipher).connection),
		),
	);

/** One of the pod's connections with its tools, or nothing. */
export const connectionIn = (
	workspaceId: string,
	podId: string,
	connectionId: string,
	cipher: Credentials.Interface,
) =>
	listedRows(
		and(
			eq(connection.id, connectionId),
			eq(connection.workspaceId, workspaceId),
			eq(connection.podId, podId),
		),
	).pipe(
		Effect.map(([found]): ConnectionWithTools | undefined => {
			if (!found) return undefined;
			const { connection: listed, tools } = toConnection(found.row, found.connectedBy, cipher);
			return { ...listed, tools };
		}),
	);

function listedRows(where: SQL | undefined) {
	return query((db) =>
		db
			.select({ row: listedRow, connectedBy: user.name })
			.from(connection)
			.leftJoin(user, eq(user.id, connection.createdById))
			.where(where)
			.orderBy(asc(connection.createdAt)),
	);
}

function toConnection(
	row: ListedRow,
	connectedBy: string | null,
	cipher: Credentials.Interface,
): { connection: Connection; tools: ConnectionToolSetting[] } {
	const tools = row.tools.map((tool) => ({ ...tool, access: toolAccessOf(row.toolAccess, tool) }));
	return {
		tools,
		connection: {
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
			toolCounts: toolAccessCountsOf(tools),
			lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
			lastTestError: row.lastTestError,
			connectedBy,
			createdAt: row.createdAt.toISOString(),
		},
	};
}
