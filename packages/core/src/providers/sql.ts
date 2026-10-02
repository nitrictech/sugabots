import type {
	ConnectionAccess,
	ConnectionAuth,
	ConnectionTool,
	ProviderApiFormat,
	ProviderModel,
	ProviderModelCapability,
	ProviderPresetId,
	SearchProviderPresetId,
} from "@sugabots/contracts";
import {
	boolean,
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
 * An MCP server a pod owner has configured for every agent in that pod.
 *
 * `handle` prefixes the server's tool names for the model, so two servers
 * with a `search` tool do not collide; unique per workspace like an agent's.
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
		url: text("url").notNull(),
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
		/** The tools the server listed when last asked, as it described them. */
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
	],
);

export type ConnectionRow = typeof connection.$inferSelect;

/** What somebody chose for the pod's bots to do with each of a connection's tools, by the server's name for it. */
export type ToolAccess = Record<string, ConnectionAccess>;

export type ModelProviderRow = typeof modelProvider.$inferSelect;
export type ProviderModelRow = typeof providerModel.$inferSelect;
