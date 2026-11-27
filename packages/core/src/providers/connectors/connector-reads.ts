import {
	type Connector,
	type ConnectorTool,
	type ConnectorToolSetting,
	type ConnectorWithTools,
	type NamedMember,
	type ProjectBotConnector,
	type RestrictableConnector,
	toolAccessCountsOf,
} from "@sugabots/contracts";
import { and, asc, eq, getColumns, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import { namedMemberColumns } from "../../chats/store/participants.ts";
import { query } from "../../database/database.ts";
import {
	bot,
	type ConnectorRow,
	connector,
	member,
	membership,
	project,
	projectBot,
	projectBotConnector,
} from "../../database/schema.ts";
import type { Secrets } from "../../secrets/secrets.ts";
import { membershipOf } from "../../workspaces/membership/member-reads.ts";
import { configurationStatus } from "../tested-configuration.ts";
import { isSignedIn, signInExpired, toolsOf } from "./connector-store.ts";
import * as GitHub from "./github/github.ts";
import { toolAccessOf } from "./tool-access.ts";

/** A tool as the server described it, less its description. */
type ToolHints = Omit<ConnectorTool, "description">;

/** A connector's row with its tools' descriptions left in the database. */
type ListedRow = Omit<ConnectorRow, "tools"> & { tools: ToolHints[] };

const { tools: _, ...columnsBesideTools } = getColumns(connector);

/**
 * The server's tools without their descriptions, which can run to many
 * kilobytes each, in the order the server listed them.
 */
const toolsWithoutDescriptions = sql<ToolHints[]>`coalesce(
	(select jsonb_agg(listed.tool - 'description' order by listed.position)
	from jsonb_array_elements(${connector.tools}) with ordinality as listed(tool, position)),
	'[]'::jsonb
)`;

const listedRow = { ...columnsBesideTools, tools: toolsWithoutDescriptions };

/** The project's connectors, oldest first, each with how many tools are at each setting. */
export const connectorsIn = (workspaceId: string, projectId: string, cipher: Secrets.Interface) =>
	listedRows(and(eq(connector.workspaceId, workspaceId), eq(connector.projectId, projectId))).pipe(
		Effect.map((rows) =>
			rows.map(({ row, ...members }) => toConnector(row, members, cipher).connector),
		),
	);

/**
 * The own connectors of the bots in the project `projectId`, by bot name and
 * then connector name, each with whether it is on in the project: turned on
 * there for the address revision it still has. Its own bot's, in a bot's
 * default project, are the project's connectors, so they aren't among them.
 * Each carries the bot's default project, where its connectors live, which
 * decides who sees its address.
 */
export const projectBotConnectorsIn = (
	workspaceId: string,
	projectId: string,
	connectorId?: string,
) =>
	query((db) =>
		db
			.select({
				id: connector.id,
				name: connector.name,
				kind: connector.kind,
				configurationRevision: connector.configurationRevision,
				url: connector.url,
				addressRevision: connector.addressRevision,
				botId: bot.id,
				botProjectId: project.id,
				turnedOnFor: projectBotConnector.addressRevision,
			})
			.from(projectBot)
			.innerJoin(bot, eq(bot.id, projectBot.botId))
			.innerJoin(project, eq(project.defaultOfBotId, bot.id))
			.innerJoin(connector, eq(connector.projectId, project.id))
			.leftJoin(
				projectBotConnector,
				and(
					eq(projectBotConnector.projectId, projectBot.projectId),
					eq(projectBotConnector.connectorId, connector.id),
				),
			)
			.where(
				and(
					eq(projectBot.workspaceId, workspaceId),
					eq(projectBot.projectId, projectId),
					sql`${project.id} <> ${projectId}`,
					connectorId === undefined ? undefined : eq(connector.id, connectorId),
				),
			)
			.orderBy(asc(bot.name), asc(connector.name)),
	).pipe(
		Effect.map((rows) =>
			rows.map(({ turnedOnFor, botProjectId, ...row }) => ({
				botProjectId,
				shown: {
					...row,
					on: turnedOnFor === row.addressRevision,
					addressChanged: turnedOnFor !== null && turnedOnFor !== row.addressRevision,
				} satisfies ProjectBotConnector,
			})),
		),
	);

export const restrictableConnectorsIn = (workspaceId: string, projectId: string) =>
	query((db) =>
		db
			.select({ id: connector.id, name: connector.name, enabled: connector.enabled })
			.from(connector)
			.where(and(eq(connector.workspaceId, workspaceId), eq(connector.projectId, projectId)))
			.orderBy(asc(connector.createdAt)),
	).pipe(
		Effect.map((rows): RestrictableConnector[] =>
			rows.map((row) => ({ ...row, restricted: true })),
		),
	);

/** One of the project's connectors with its tools, or nothing. */
export const connectorIn = (
	workspaceId: string,
	projectId: string,
	connectorId: string,
	cipher: Secrets.Interface,
) =>
	listedRows(
		and(
			eq(connector.id, connectorId),
			eq(connector.workspaceId, workspaceId),
			eq(connector.projectId, projectId),
		),
	).pipe(
		Effect.map(([found]): ConnectorWithTools | undefined => {
			if (!found) return undefined;
			const { connector: listed, tools } = toConnector(found.row, found, cipher);
			return { ...listed, tools };
		}),
	);

/** The member a connector signs in as, beside whoever added it. */
const signer = alias(member, "signer");
const signerMembership = alias(membership, "signer_membership");

/** Whoever made its OAuth sign-in, or installed its GitHub app on their own account; a connector has one or neither. */
const signedInAsId = sql`coalesce(${connector.signedInById}, ${connector.installedById})`;

/**
 * Connectors with whoever added each, and whoever each signs in as, while they
 * are still in the workspace.
 */
function listedRows(where: SQL | undefined) {
	return query((db) =>
		db
			.select({
				row: listedRow,
				connectedBy: namedMemberColumns,
				signedInAs: { id: signer.id, name: signer.name, email: signer.email, image: signer.image },
			})
			.from(connector)
			.leftJoin(membership, membershipOf(connector.workspaceId, connector.createdById))
			.leftJoin(member, eq(member.id, membership.memberId))
			.leftJoin(
				signerMembership,
				and(
					eq(signerMembership.workspaceId, connector.workspaceId),
					eq(signerMembership.memberId, signedInAsId),
				),
			)
			.leftJoin(signer, eq(signer.id, signerMembership.memberId))
			.where(where)
			.orderBy(asc(connector.createdAt)),
	);
}

function toConnector(
	row: ListedRow,
	{ connectedBy, signedInAs }: { connectedBy: NamedMember | null; signedInAs: NamedMember | null },
	cipher: Secrets.Interface,
): { connector: Connector; tools: ConnectorToolSetting[] } {
	const tools = toolsOf(row).map((tool) => ({
		name: tool.name,
		readOnly: tool.readOnly,
		destructive: tool.destructive,
		access: toolAccessOf(row.toolAccess, tool),
	}));
	return {
		tools,
		connector: {
			id: row.id,
			workspaceId: row.workspaceId,
			projectId: row.projectId,
			name: row.name,
			enabled: row.enabled,
			handle: row.handle,
			kind: row.kind,
			configurationRevision: row.configurationRevision,
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
			signedInAs,
			createdAt: row.createdAt.toISOString(),
		},
	};
}
