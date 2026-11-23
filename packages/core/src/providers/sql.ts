import type {
	BuiltInProviderId,
	BuiltInSearchProviderId,
	ConnectorAccess,
	ConnectorAuth,
	ConnectorKind,
	ConnectorTool,
	ProviderApiFormat,
	ProviderModel,
	ProviderModelCapability,
} from "@sugabots/contracts";
import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	foreignKey,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { primaryKey, stamp, updatedStamp } from "../database/sql.ts";
import { person, project, workspace } from "../workspaces/sql.ts";

interface EncryptedProviderHeader {
	name: string;
	value: string;
}

export const modelProvider = pgTable(
	"model_provider",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspace.id, { onDelete: "cascade" }),
		/** The built-in provider this was made from; null is a custom model provider. */
		builtIn: text("built_in").$type<BuiltInProviderId>(),
		name: text("name").notNull(),
		baseUrl: text("base_url").notNull(),
		apiFormat: text("api_format").$type<ProviderApiFormat>().notNull(),
		active: boolean("active").notNull().default(false),
		apiKeyEncrypted: text("api_key_encrypted"),
		customHeadersEncrypted: jsonb("custom_headers_encrypted")
			.$type<EncryptedProviderHeader[]>()
			.notNull()
			.default([]),
		/** The OAuth tokens of a subscription sign-in, sealed JSON; only a provider that signs in has them. */
		oauthTokensEncrypted: text("oauth_tokens_encrypted"),
		lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
		lastTestError: text("last_test_error"),
		/** Who connected it: who gave it its key, signed it in, or switched on one that takes neither. */
		connectedById: uuid("connected_by_id").references(() => person.id, { onDelete: "set null" }),
		createdById: uuid("created_by_id").references(() => person.id, { onDelete: "set null" }),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		uniqueIndex("model_provider_name_idx").on(table.workspaceId, table.name),
		uniqueIndex("model_provider_id_workspace_id_idx").on(table.id, table.workspaceId),
	],
);

export const providerModel = pgTable(
	"provider_model",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspace.id, { onDelete: "cascade" }),
		providerId: uuid("provider_id").notNull(),
		modelId: text("model_id").notNull(),
		displayName: text("display_name"),
		capabilities: jsonb("capabilities").$type<ProviderModelCapability[]>().notNull().default([]),
		/** Of `capabilities`, the ones an admin switched off for bots. */
		disabledCapabilities: jsonb("disabled_capabilities")
			.$type<ProviderModelCapability[]>()
			.notNull()
			.default([]),
		contextLength: integer("context_length"),
		enabled: boolean("enabled").notNull().default(false),
		source: text("source").$type<ProviderModel["source"]>().notNull(),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		foreignKey({
			columns: [table.providerId, table.workspaceId],
			foreignColumns: [modelProvider.id, modelProvider.workspaceId],
			name: "provider_model_provider_workspace_fkey",
		}).onDelete("cascade"),
		uniqueIndex("provider_model_provider_id_idx").on(table.providerId, table.modelId),
		uniqueIndex("provider_model_workspace_id_idx").on(table.workspaceId, table.modelId),
	],
);

/**
 * The model a workspace's new bots start on, by the `model_id` bots name
 * it by. A workspace has none until it first offers a model, and from then on
 * always has one: `ModelProviderSetup` refuses any change that would stop
 * offering it, deleting its row included, until another replaces it.
 */
export const workspaceDefaultModel = pgTable("workspace_default_model", {
	workspaceId: uuid("workspace_id")
		.primaryKey()
		.references(() => workspace.id, { onDelete: "cascade" }),
	modelId: text("model_id").notNull(),
	updatedAt: updatedStamp("updated_at"),
});

/**
 * Where a workspace's `web_search` tool sends its queries: one search service,
 * from a built-in search provider, with the workspace's own key. One per workspace,
 * which the unique index on `workspace_id` says; setting another replaces it.
 * The key is sealed with the same server key as a model provider's.
 */
export const searchProvider = pgTable(
	"search_provider",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspace.id, { onDelete: "cascade" }),
		builtIn: text("built_in").$type<BuiltInSearchProviderId>().notNull(),
		baseUrl: text("base_url").notNull(),
		enabled: boolean("enabled").notNull().default(false),
		apiKeyEncrypted: text("api_key_encrypted"),
		lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
		lastTestError: text("last_test_error"),
		createdById: uuid("created_by_id").references(() => person.id, { onDelete: "set null" }),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		uniqueIndex("search_provider_workspace_idx").on(table.workspaceId),
		uniqueIndex("search_provider_id_workspace_id_idx").on(table.id, table.workspaceId),
	],
);

export type SearchProviderRow = typeof searchProvider.$inferSelect;

/**
 * A service a project is connected to, by `kind`: an MCP server at `url`; the
 * project's own GitHub App, whose tools are Sugabots' own, on the repositories
 * in its `settings`; or an HTTP endpoint, whose requests stay under `url` and
 * carry the header secret, if any. A project has at most one GitHub app, since
 * its computer can be signed in to only one account there. A bot's own
 * connectors are its default project's.
 *
 * `handle` prefixes the tool names for the model, so two connectors with a
 * `search` tool do not collide; unique per project.
 */
export const connector = pgTable(
	"connector",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspace.id, { onDelete: "cascade" }),
		projectId: uuid("project_id").notNull(),
		name: text("name").notNull(),
		handle: text("handle").notNull(),
		kind: text("kind").$type<ConnectorKind>().notNull().default("mcp"),
		/**
		 * The MCP server's address; for GitHub, the page of the account its app
		 * is installed on, or of the app itself until it is.
		 */
		url: text("url").notNull(),
		/** What a connector of a kind other than MCP is, which may be shown; its shape follows `kind`. */
		settings: jsonb("settings").$type<ConnectorSettings>(),
		/** For GitHub, the connector's own app's private key and webhook secret, sealed as one document. */
		appCredentialEncrypted: text("app_credential_encrypted"),
		/** `header`: a pasted secret in `secret_encrypted`; `oauth`: tokens in `oauth_encrypted`. */
		authKind: text("auth_kind").$type<ConnectorAuth>().notNull().default("header"),
		secretHeader: text("secret_header"),
		secretEncrypted: text("secret_encrypted"),
		/** The OAuth client, its tokens and an in-flight sign-in's verifier, sealed as one JSON document. */
		oauthEncrypted: text("oauth_encrypted"),
		/** The `state` of a sign-in under way, so the callback can find its connector. */
		oauthState: text("oauth_state"),
		/** Incremented whenever the configured target or availability changes. */
		configurationRevision: integer("configuration_revision").notNull().default(1),
		/** The tools the server listed when last asked, as it described them; for GitHub, Sugabots' own. */
		tools: jsonb("tools").$type<ConnectorTool[]>().notNull().default([]),
		/**
		 * What somebody chose for the bot to do with each tool, by the
		 * server's name for it; see `connectorAccesses`. A tool with no choice
		 * gets its default from how the server describes it now. A choice is kept
		 * while the server stops listing its tool, so a tool turned off stays off
		 * when the server lists it again.
		 */
		toolAccess: jsonb("tool_access").$type<ToolAccess>().notNull().default({}),
		lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
		lastTestError: text("last_test_error"),
		createdById: uuid("created_by_id").references(() => person.id, { onDelete: "set null" }),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		foreignKey({
			columns: [table.projectId, table.workspaceId],
			foreignColumns: [project.id, project.workspaceId],
			name: "connector_project_workspace_fkey",
		}).onDelete("cascade"),
		uniqueIndex("connector_name_idx").on(table.projectId, table.name),
		uniqueIndex("connector_handle_idx").on(table.projectId, table.handle),
		uniqueIndex("connector_github_project_idx")
			.on(table.projectId)
			.where(sql`${table.kind} = 'github'`),
		uniqueIndex("connector_id_workspace_id_idx").on(table.id, table.workspaceId),
		uniqueIndex("connector_oauth_state_idx").on(table.oauthState),
		check("connector_kind_check", sql`${table.kind} in ('mcp', 'github', 'http')`),
		check(
			"connector_http_auth_check",
			sql`${table.kind} <> 'http' or ${table.authKind} = 'header'`,
		),
		check(
			"connector_settings_kind_check",
			sql`(${table.kind} = 'github') = (${table.settings} is not null)
				and (${table.settings} is null or ${table.settings}->>'kind' = ${table.kind})`,
		),
		check(
			"connector_app_credential_kind_check",
			sql`(${table.kind} = 'github') = (${table.appCredentialEncrypted} is not null)`,
		),
	],
);

type ConnectorSettings = GitHubConnectorSettings;

/** A GitHub App's owner: an organization, or a person's own account. */
export interface GitHubAppOwner {
	readonly login: string;
	readonly type: "Organization" | "User";
}

/**
 * A GitHub connector's own GitHub App, which a person made from Sugabots'
 * manifest under the account its bot works on, and the app's installation
 * there: both null until the app is installed.
 */
export interface GitHubConnectorSettings {
	readonly kind: "github";
	readonly appId: number;
	/** The app's name in its github.com/apps/ address. */
	readonly slug: string;
	/** Who owns the app on GitHub, whose settings change or delete it. */
	readonly owner: GitHubAppOwner;
	readonly installationId: number | null;
	/** The login of the organization or person it is installed on. */
	readonly account: string | null;
	/**
	 * The repositories its tools work on: bots in its project read them in the
	 * project's computer, push branches to them and open pull requests on
	 * them, and their events may start the project's automations.
	 */
	readonly repositories: readonly GitHubConnectorRepository[];
}

/** One of a GitHub connector's repositories. */
export interface GitHubConnectorRepository {
	/** GitHub's id for it, which stays the same when it is renamed or moved. */
	readonly id: number;
	/** `owner/name`, as GitHub last wrote it. */
	readonly path: string;
	/** Who added it; null once they have left. */
	readonly addedById: string | null;
	/** When it was added, as an ISO timestamp. */
	readonly addedAt: string;
}

export type ConnectorRow = typeof connector.$inferSelect;

/** What somebody chose for the bot to do with each of a connector's tools, by the server's name for it. */
export type ToolAccess = Record<string, ConnectorAccess>;

export type ModelProviderRow = typeof modelProvider.$inferSelect;
export type ProviderModelRow = typeof providerModel.$inferSelect;
