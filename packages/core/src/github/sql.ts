import type { GithubConnectionMethod } from "@sugabots/contracts";
import {
	boolean,
	foreignKey,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { primaryKey, stamp, updatedStamp } from "../database/sql.ts";
import { pod, user, workspace } from "../workspaces/sql.ts";

/**
 * How a workspace reaches GitHub: one connection, holding a token sealed with
 * the same server key as a model provider's. It never reaches a sandbox; the
 * sandbox's egress sidecar adds it to git requests for the pod's repositories.
 */
export const githubConnection = pgTable(
	"github_connection",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspace.id, { onDelete: "cascade" }),
		method: text("method").$type<GithubConnectionMethod>().notNull(),
		apiBaseUrl: text("api_base_url").notNull(),
		gitHost: text("git_host").notNull(),
		/** A personal access token, sealed. Set only for the `token` method. */
		tokenEncrypted: text("token_encrypted"),
		/** The GitHub App's id, slug and private key, sealed. Set only for the `app` method. */
		appId: text("app_id"),
		appSlug: text("app_slug"),
		appPrivateKeyEncrypted: text("app_private_key_encrypted"),
		/** Where the app is installed. Null until the admin has installed it. */
		appInstallationId: text("app_installation_id"),
		/** Whose token it is, as GitHub said at the last successful test. */
		accountLogin: text("account_login"),
		lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
		lastTestError: text("last_test_error"),
		createdById: uuid("created_by_id").references(() => user.id, { onDelete: "set null" }),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [uniqueIndex("github_connection_workspace_idx").on(table.workspaceId)],
);

export type GithubConnectionRow = typeof githubConnection.$inferSelect;

/**
 * A repository a pod's agents may check out. What GitHub said about it when
 * it was added is kept, so a turn can name its default branch without asking.
 */
export const podRepository = pgTable(
	"pod_repository",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id").notNull(),
		podId: uuid("pod_id").notNull(),
		/** `owner/name`. */
		fullName: text("full_name").notNull(),
		defaultBranch: text("default_branch").notNull(),
		private: boolean("private").notNull(),
		createdById: uuid("created_by_id").references(() => user.id, { onDelete: "set null" }),
		createdAt: stamp("created_at"),
	},
	(table) => [
		foreignKey({
			columns: [table.podId, table.workspaceId],
			foreignColumns: [pod.id, pod.workspaceId],
			name: "pod_repository_pod_workspace_fkey",
		}).onDelete("cascade"),
		uniqueIndex("pod_repository_pod_name_idx").on(table.podId, table.fullName),
	],
);

export type PodRepositoryRow = typeof podRepository.$inferSelect;
