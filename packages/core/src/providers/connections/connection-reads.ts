import {
	type Connection,
	type ConnectionTool,
	type ConnectionToolSetting,
	type ConnectionWithTools,
	type NamedPerson,
	toolAccessCountsOf,
} from "@sugabots/contracts";
import { and, asc, eq, getColumns, type SQL, sql } from "drizzle-orm";
import { Effect } from "effect";
import { namedPersonColumns } from "../../conversations/repository/participants.ts";
import type { Credentials } from "../../credentials/credentials.ts";
import { query } from "../../database/database.ts";
import { type ConnectionRow, connection, user, workspaceMember } from "../../database/schema.ts";
import { configurationStatus } from "../tested-configuration.ts";
import { isSignedIn, signInExpired, toolsOf } from "./connection-repository.ts";
import * as GitHub from "./github/github.ts";
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

/** The project's connections, oldest first, each with how many tools are at each setting. */
export const connectionsIn = (
	workspaceId: string,
	projectId: string,
	cipher: Credentials.Interface,
) =>
	listedRows(
		and(eq(connection.workspaceId, workspaceId), eq(connection.projectId, projectId)),
	).pipe(
		Effect.map((rows) =>
			rows.map(({ row, connectedBy }) => toConnection(row, connectedBy, cipher).connection),
		),
	);

/** One of the project's connections with its tools, or nothing. */
export const connectionIn = (
	workspaceId: string,
	projectId: string,
	connectionId: string,
	cipher: Credentials.Interface,
) =>
	listedRows(
		and(
			eq(connection.id, connectionId),
			eq(connection.workspaceId, workspaceId),
			eq(connection.projectId, projectId),
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
			.select({
				row: listedRow,
				connectedBy: namedPersonColumns,
			})
			.from(connection)
			.leftJoin(
				workspaceMember,
				and(
					eq(workspaceMember.workspaceId, connection.workspaceId),
					eq(workspaceMember.userId, connection.createdById),
				),
			)
			.leftJoin(user, eq(user.id, workspaceMember.userId))
			.where(where)
			.orderBy(asc(connection.createdAt)),
	);
}

function toConnection(
	row: ListedRow,
	connectedBy: NamedPerson | null,
	cipher: Credentials.Interface,
): { connection: Connection; tools: ConnectionToolSetting[] } {
	const tools = toolsOf(row).map((tool) => ({
		name: tool.name,
		readOnly: tool.readOnly,
		destructive: tool.destructive,
		access: toolAccessOf(row.toolAccess, tool),
	}));
	return {
		tools,
		connection: {
			id: row.id,
			workspaceId: row.workspaceId,
			projectId: row.projectId,
			name: row.name,
			handle: row.handle,
			kind: row.kind,
			url: row.url,
			auth: row.authKind,
			signedIn: isSignedIn(row, cipher),
			signInExpired: signInExpired(row, cipher),
			secretHeader: row.secretHeader,
			hasSecret: row.secretEncrypted !== null,
			appSettingsUrl: row.settings ? GitHub.appSettingsUrl(row.settings) : null,
			status: configurationStatus({
				missingKey: false,
				lastTestedAt: row.lastTestedAt,
				lastTestError: row.lastTestError,
			}),
			toolCounts: toolAccessCountsOf(tools),
			lastTestError: row.lastTestError,
			connectedBy,
			createdAt: row.createdAt.toISOString(),
		},
	};
}
