import type {
	ConnectionAccess,
	ConnectionAuth,
	ConnectionKind,
	ConnectionTool,
	ProviderApiFormat,
	ProviderModel,
	ProviderModelCapability,
	ProviderPresetId,
	SearchProviderPresetId,
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
import { pod, user, workspace } from "../workspaces/sql.ts";

export interface EncryptedProviderHeader {
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
		/** The catalog entry this was made from; null is a custom endpoint. */
		preset: text("preset").$type<ProviderPresetId>(),
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
		createdById: uuid("created_by_id").references(() => user.id, { onDelete: "set null" }),
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
		/** Of `capabilities`, the ones an admin switched off for agents. */
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
 * The model a workspace's new agents start on, by the `model_id` agents name
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
 * from the search catalog, with the workspace's own key. One per workspace,
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
		preset: text("preset").$type<SearchProviderPresetId>().notNull(),
		baseUrl: text("base_url").notNull(),
		enabled: boolean("enabled").notNull().default(false),
		apiKeyEncrypted: text("api_key_encrypted"),
		lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
		lastTestError: text("last_test_error"),
		createdById: uuid("created_by_id").references(() => user.id, { onDelete: "set null" }),
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
 * A service a pod owner has connected every agent in that pod to, by `kind`:
 * an MCP server at `url`; the pod's own GitHub App, whose tools are
 * Sugabots' own, on the repositories in its `settings`; or an HTTP endpoint,
 * whose requests stay under `url` and carry the header secret, if any.
 * A pod has at most one GitHub connection, since its sandbox can be signed in
 * to only one account there.
 *
 * `handle` prefixes the tool names for the model, so two connections with a
 * `search` tool do not collide; unique per workspace like an agent's.
 */
export const connection = pgTable(
	"connection",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspace.id, { onDelete: "cascade" }),
		podId: uuid("pod_id").notNull(),
		name: text("name").notNull(),
		handle: text("handle").notNull(),
		kind: text("kind").$type<ConnectionKind>().notNull().default("mcp"),
		/**
		 * The MCP server's address; for GitHub, the page of the account its app
		 * is installed on, or of the app itself until it is.
		 */
		url: text("url").notNull(),
		/** What a connection of a kind other than MCP is, which may be shown; its shape follows `kind`. */
		settings: jsonb("settings").$type<ConnectionSettings>(),
		/** For GitHub, the connection's own app's private key and webhook secret, sealed as one document. */
		appCredentialEncrypted: text("app_credential_encrypted"),
		/** `header`: a pasted secret in `secret_encrypted`; `oauth`: tokens in `oauth_encrypted`. */
		authKind: text("auth_kind").$type<ConnectionAuth>().notNull().default("header"),
		secretHeader: text("secret_header"),
		secretEncrypted: text("secret_encrypted"),
		/** The OAuth client, its tokens and an in-flight sign-in's verifier, sealed as one JSON document. */
		oauthEncrypted: text("oauth_encrypted"),
		/** The `state` of a sign-in under way, so the callback can find its connection. */
		oauthState: text("oauth_state"),
		/** Incremented whenever the configured target or availability changes. */
		configurationRevision: integer("configuration_revision").notNull().default(1),
		/** The tools the server listed when last asked, as it described them; for GitHub, Sugabots' own. */
		tools: jsonb("tools").$type<ConnectionTool[]>().notNull().default([]),
		/**
		 * What somebody chose for the pod's bots to do with each tool, by the
		 * server's name for it; see `connectionAccesses`. A tool with no choice
		 * gets its default from how the server describes it now. A choice is kept
		 * while the server stops listing its tool, so a tool turned off stays off
		 * when the server lists it again.
		 */
		toolAccess: jsonb("tool_access").$type<ToolAccess>().notNull().default({}),
		lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
		lastTestError: text("last_test_error"),
		createdById: uuid("created_by_id").references(() => user.id, { onDelete: "set null" }),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		foreignKey({
			columns: [table.podId, table.workspaceId],
			foreignColumns: [pod.id, pod.workspaceId],
			name: "connection_pod_workspace_fkey",
		}).onDelete("cascade"),
		uniqueIndex("connection_name_idx").on(table.podId, table.name),
		uniqueIndex("connection_handle_idx").on(table.podId, table.handle),
		uniqueIndex("connection_id_workspace_id_idx").on(table.id, table.workspaceId),
		uniqueIndex("connection_id_pod_id_idx").on(table.id, table.podId),
		uniqueIndex("connection_oauth_state_idx").on(table.oauthState),
		uniqueIndex("connection_github_pod_idx").on(table.podId).where(sql`${table.kind} = 'github'`),
		check("connection_kind_check", sql`${table.kind} in ('mcp', 'github', 'http')`),
		check(
			"connection_http_auth_check",
			sql`${table.kind} <> 'http' or ${table.authKind} = 'header'`,
		),
		check(
			"connection_settings_kind_check",
			sql`(${table.kind} = 'github') = (${table.settings} is not null)
				and (${table.settings} is null or ${table.settings}->>'kind' = ${table.kind})`,
		),
		check(
			"connection_app_credential_kind_check",
			sql`(${table.kind} = 'github') = (${table.appCredentialEncrypted} is not null)`,
		),
	],
);

export type ConnectionSettings = GitHubConnectionSettings;

/** A GitHub App's owner: an organization, or a person's own account. */
export interface GitHubAppOwner {
	readonly login: string;
	readonly type: "Organization" | "User";
}

/**
 * A GitHub connection's own GitHub App, which a person made from Sugabots'
 * manifest under the account its pod works on, and the app's installation
 * there: both null until the app is installed.
 */
export interface GitHubConnectionSettings {
	readonly kind: "github";
	readonly appId: number;
	/** The app's name in its github.com/apps/ address. */
	readonly slug: string;
	/** Who owns the app on GitHub, whose settings change or delete it. */
	readonly owner: GitHubAppOwner;
	readonly installationId: number | null;
	/** The login of the organization or user it is installed on. */
	readonly account: string | null;
	/**
	 * The repositories its tools work on: they read them in the pod's
	 * sandbox, push branches to them and open pull requests on them, and their
	 * events may start the pod's routines.
	 */
	readonly repositories: readonly GitHubConnectionRepository[];
}

/** One of a GitHub connection's repositories. */
export interface GitHubConnectionRepository {
	/** GitHub's id for it, which stays the same when it is renamed or moved. */
	readonly id: number;
	/** `owner/name`, as GitHub last wrote it. */
	readonly path: string;
	/** Who added it; null once they have left. */
	readonly addedById: string | null;
	/** When it was added, as an ISO timestamp. */
	readonly addedAt: string;
}

export type ConnectionRow = typeof connection.$inferSelect;

/** What somebody chose for the pod's bots to do with each of a connection's tools, by the server's name for it. */
export type ToolAccess = Record<string, ConnectionAccess>;

export type ModelProviderRow = typeof modelProvider.$inferSelect;
export type ProviderModelRow = typeof providerModel.$inferSelect;
