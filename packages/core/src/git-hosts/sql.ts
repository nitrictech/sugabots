import { sql } from "drizzle-orm";
import {
	check,
	primaryKey as compositePrimaryKey,
	foreignKey,
	pgTable,
	text,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { primaryKey, stamp, updatedStamp } from "../database/sql.ts";
import { pod, user, workspace } from "../workspaces/sql.ts";
import type { GitHostKind } from "./credential.ts";

/**
 * Somewhere a workspace keeps code, and the credential Sugabots works there
 * with: for GitHub, an app the workspace made, installed on one account. What
 * the credential holds depends on `kind`; it is sealed, and parsed by
 * `credential.ts`.
 */
export const gitHost = pgTable(
	"git_host",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspace.id, { onDelete: "cascade" }),
		kind: text("kind").$type<GitHostKind>().notNull(),
		/** What the host calls the credential's owner, such as a GitHub App's name. */
		name: text("name").notNull(),
		/** The organization or user whose repositories it reaches; null until a GitHub App is installed. */
		account: text("account"),
		credentialEncrypted: text("credential_encrypted").notNull(),
		createdById: uuid("created_by_id").references(() => user.id, { onDelete: "set null" }),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		uniqueIndex("git_host_id_workspace_id_idx").on(table.id, table.workspaceId),
		check("git_host_kind_check", sql`${table.kind} in ('github')`),
	],
);

/** A repository a pod's agents may read in its sandbox, push branches to, and open pull requests on. */
export const podRepository = pgTable(
	"pod_repository",
	{
		workspaceId: uuid("workspace_id").notNull(),
		podId: uuid("pod_id").notNull(),
		gitHostId: uuid("git_host_id").notNull(),
		/** Its full name at the host, `owner/name`. */
		repository: text("repository").notNull(),
		addedById: uuid("added_by_id").references(() => user.id, { onDelete: "set null" }),
		createdAt: stamp("created_at"),
	},
	(table) => [
		compositePrimaryKey({ columns: [table.podId, table.gitHostId, table.repository] }),
		foreignKey({
			columns: [table.podId, table.workspaceId],
			foreignColumns: [pod.id, pod.workspaceId],
			name: "pod_repository_pod_workspace_fkey",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.gitHostId, table.workspaceId],
			foreignColumns: [gitHost.id, gitHost.workspaceId],
			name: "pod_repository_git_host_workspace_fkey",
		}).onDelete("cascade"),
	],
);
