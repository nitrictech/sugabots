import type {
	AgentColor,
	AgentFace,
	AssignableWorkspaceRole,
	PodColor,
	PodRouting,
	SystemAgentKey,
	WorkspaceRole,
} from "@sugabots/contracts";
import {
	ASSIGNABLE_WORKSPACE_ROLES,
	DEFAULT_POD_ROUTING,
	DEFAULT_TIME_ZONE,
	WORKSPACE_ROLES,
} from "@sugabots/contracts";
import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	boolean,
	check,
	foreignKey,
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { primaryKey, stamp, updatedStamp } from "../database/sql.ts";

/** Text with a check constraint rather than a Postgres enum, so adding a role needs no type migration. */
const workspaceRole = <Role extends WorkspaceRole = WorkspaceRole>(name: string) =>
	text(name).$type<Role>();

function roleIsOneOf(column: AnyPgColumn, roles: readonly WorkspaceRole[]) {
	return sql`${column} in (${sql.join(
		roles.map((role) => sql.raw(`'${role}'`)),
		sql`, `,
	)})`;
}

/** A person. One row per human, across every workspace they belong to. */
export const user = pgTable(
	"user",
	{
		id: primaryKey(),
		name: text("name").notNull(),
		email: text("email").notNull(),
		emailVerified: boolean("email_verified").notNull().default(false),
		image: text("image"),
		onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
		/** Who sent the referral link this person signed up with. */
		referredBy: uuid("referred_by").references((): AnyPgColumn => user.id, {
			onDelete: "set null",
		}),
		/** The code in this person's referral link, made when they first ask for it and replaced when they reset it. */
		referralCode: text("referral_code"),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		uniqueIndex("user_email_idx").on(table.email),
		uniqueIndex("user_referral_code_idx").on(table.referralCode),
		index("user_referred_by_idx").on(table.referredBy),
	],
);

/**
 * A signed-in client. `token` is the bearer token: the browser, Electron and
 * React Native all hold one of these and send it on every request.
 */
export const session = pgTable(
	"session",
	{
		id: primaryKey(),
		token: text("token").notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		uniqueIndex("session_token_idx").on(table.token),
		index("session_user_id_idx").on(table.userId),
	],
);

/**
 * How a user proves who they are. One row per credential: `password` for email
 * and password, or the tokens from an OAuth provider when we add one.
 */
export const account = pgTable(
	"account",
	{
		id: primaryKey(),
		accountId: text("account_id").notNull(),
		providerId: text("provider_id").notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		password: text("password"),
		accessToken: text("access_token"),
		refreshToken: text("refresh_token"),
		idToken: text("id_token"),
		accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
		refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
		scope: text("scope"),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [index("account_user_id_idx").on(table.userId)],
);

/** Short-lived tokens: email verification, password reset. */
export const verification = pgTable(
	"verification",
	{
		id: primaryKey(),
		identifier: text("identifier").notNull(),
		value: text("value").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [index("verification_identifier_idx").on(table.identifier)],
);

/**
 * The tenant. Every other table carries a `workspace_id`, directly or through
 * its parent, and every query is scoped by it.
 */
export const workspace = pgTable(
	"workspace",
	{
		id: primaryKey(),
		name: text("name").notNull(),
		// URL-facing identifier: `/w/acme`. Unique across the installation.
		slug: text("slug").notNull(),
		// Not yet settable.
		logo: text("logo"),
		/** An IANA time zone: where the workspace's days and months begin. */
		timeZone: text("time_zone").notNull().default(DEFAULT_TIME_ZONE),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [uniqueIndex("workspace_slug_idx").on(table.slug)],
);

/**
 * Who belongs to a workspace, and whether they may administer it.
 *
 * `workspace_member_owner_idx` lets a workspace have one owner at most. That
 * it has one at least is `Membership`'s to keep: the creator is made owner, and
 * the owner's row changes only by transferring ownership.
 */
export const workspaceMember = pgTable(
	"workspace_member",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspace.id, { onDelete: "cascade" }),
		userId: uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		role: workspaceRole("role").notNull().default("member"),
		createdAt: stamp("created_at"),
	},
	(table) => [
		uniqueIndex("workspace_member_idx").on(table.workspaceId, table.userId),
		index("workspace_member_user_id_idx").on(table.userId),
		uniqueIndex("workspace_member_owner_idx")
			.on(table.workspaceId)
			.where(sql`${table.role} = 'owner'`),
		check("workspace_member_role_check", roleIsOneOf(table.role, WORKSPACE_ROLES)),
	],
);

/** An invitation to join a workspace, addressed to an email. */
export const workspaceInvite = pgTable(
	"workspace_invite",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspace.id, { onDelete: "cascade" }),
		// Stored lower-cased, and compared with the account's address lower-cased.
		email: text("email").notNull(),
		role: workspaceRole<AssignableWorkspaceRole>("role").notNull().default("member"),
		status: text("status")
			.$type<"pending" | "accepted" | "canceled">()
			.notNull()
			.default("pending"),
		inviterId: uuid("inviter_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: stamp("created_at"),
	},
	(table) => [
		index("workspace_invite_workspace_id_idx").on(table.workspaceId),
		index("workspace_invite_email_idx").on(table.email),
		check("workspace_invite_role_check", roleIsOneOf(table.role, ASSIGNABLE_WORKSPACE_ROLES)),
		check(
			"workspace_invite_status_check",
			sql`${table.status} in ('pending', 'accepted', 'canceled')`,
		),
	],
);

export const pod = pgTable(
	"pod",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspace.id, { onDelete: "cascade" }),
		// Whose Personal pod this is. Null on a shared pod: a shared pod is
		// administered by the workspace's admins, so it has no special person.
		ownerId: uuid("owner_id"),
		kind: text("kind").$type<"personal" | "shared">().notNull(),
		name: text("name").notNull(),
		slug: text("slug").notNull(),
		// One of the contract's pod colour names, as `agent.color` is a bot's.
		// Null reads as the default colour; a Personal pod is drawn as its lock
		// rather than a tile, so its colour is never shown.
		color: text("color").$type<PodColor>(),
		// Whether non-chat threads use the Facilitator to choose speakers.
		routing: jsonb("routing").$type<PodRouting>().notNull().default(DEFAULT_POD_ROUTING),
		// Who made it. Kept when they leave, so the record survives the person.
		createdById: uuid("created_by_id").references(() => user.id, { onDelete: "set null" }),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	// Slugs are unique among a workspace's shared pods. Every Personal pod is
	// `personal`, which only its owner ever sees, so within one person's view
	// the slug still names one pod.
	(table) => [
		check("pod_kind_check", sql`${table.kind} in ('personal', 'shared')`),
		check(
			"pod_personal_owner_check",
			sql`${table.kind} = 'shared' or ${table.ownerId} is not null`,
		),
		check(
			"pod_personal_slug_check",
			sql`(${table.kind} = 'personal') = (${table.slug} = 'personal')`,
		),
		// Composite foreign keys are not enforced when a column is null, so this
		// binds a Personal pod to its owner's membership and leaves shared pods
		// alone. Leaving or being removed takes the Personal pod with it.
		foreignKey({
			columns: [table.workspaceId, table.ownerId],
			foreignColumns: [workspaceMember.workspaceId, workspaceMember.userId],
			name: "pod_owner_workspace_member_fkey",
		}).onDelete("cascade"),
		uniqueIndex("pod_slug_idx")
			.on(table.workspaceId, table.slug)
			.where(sql`${table.kind} = 'shared'`),
		uniqueIndex("personal_pod_owner_idx")
			.on(table.workspaceId, table.ownerId)
			.where(sql`${table.kind} = 'personal'`),
		uniqueIndex("pod_id_workspace_id_idx").on(table.id, table.workspaceId),
		// Listing a workspace's pods names no kind, so neither partial index above
		// can answer it.
		index("pod_workspace_id_idx").on(table.workspaceId),
	],
);

/**
 * Who has been added to a pod.
 *
 * These rows are the whole answer to who is in a shared pod. Nobody reaches one
 * without a row: every workspace admin has one in every shared pod, and
 * demoting them leaves their rows as they are.
 *
 * There is no role here. What somebody may configure is their workspace role,
 * which lives on `workspace_member`. Adding a column here later is cheaper
 * than pretending to a distinction the product does not yet make.
 *
 * A Personal pod admits its owner and nobody else, and the database enforces
 * that: the `personal_pod_owner_membership` trigger rejects any other row.
 * Drizzle has no way to declare a trigger, so it lives in the migration that
 * added it (`20260922010506_productive_dreadnoughts`) and is named here
 * because this is where somebody checking what constrains these rows looks.
 *
 * The administrators' rows are written by triggers too, added in
 * `20260928141359_admins_in_every_pod` and extended to the owner in
 * `20260929002409_workspace_owner`: `shared_pod_administrators` adds every
 * owner and admin to a new shared pod, and `administrator_shared_pods` adds a
 * new owner or admin to every shared pod. Both take
 * `lock_pod_membership(workspace_id)`, as must anything that removes a row
 * on the strength of somebody's role, so a promotion cannot slip between them.
 */
export const podMember = pgTable(
	"pod_member",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id").notNull(),
		podId: uuid("pod_id").notNull(),
		userId: uuid("user_id").notNull(),
		createdAt: stamp("created_at"),
	},
	(table) => [
		foreignKey({
			columns: [table.podId, table.workspaceId],
			foreignColumns: [pod.id, pod.workspaceId],
			name: "pod_member_pod_workspace_fkey",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.workspaceId, table.userId],
			foreignColumns: [workspaceMember.workspaceId, workspaceMember.userId],
			name: "pod_member_workspace_member_fkey",
		}).onDelete("cascade"),
		uniqueIndex("pod_member_idx").on(table.podId, table.userId),
		// "Which pods can this person see", which is every sidebar load.
		index("pod_member_user_id_idx").on(table.userId),
	],
);

/**
 * A configured model: a name, a face, a prompt and the tools it may reach for.
 *
 * A row is one of two things, and `agent_placement_check` is what keeps it to
 * one of them: a crew agent, which belongs to exactly one pod, or a system
 * agent, which belongs to the workspace and sits in no pod. A crew agent with
 * no pod would be reachable by id and invisible to every pod authorisation
 * path, so the constraint is load-bearing rather than tidiness.
 *
 * Either may have no `model`, which means nobody has chosen one. That is a
 * state the product allows rather than a broken row: a system agent does not
 * run, and a crew agent's turns refuse with a reason naming it.
 *
 * `name` is unique per workspace because a name is how a person addresses an
 * agent: `@Linear Handler` in a message has to mean one of them.
 *
 * `color` and `face` are the whole avatar. Two small columns rather than an
 * image, which is what lets an agent created at run time have a face at all.
 */
export const agent = pgTable(
	"agent",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspace.id, { onDelete: "cascade" }),
		// Null for a system agent, which serves every pod rather than sitting in one.
		podId: uuid("pod_id"),
		name: text("name").notNull(),
		// How the agent is addressed in a message: `@personal-assistant`.
		// Derived from the name unless an admin sets one; unique per workspace.
		handle: text("handle").notNull(),
		systemAgentKey: text("system_agent_key").$type<SystemAgentKey>(),
		provisionedKey: text("provisioned_key").$type<"personal-assistant">(),
		description: text("description"),
		// One of the contract's colour names. Not a Postgres enum: the palette is
		// the contract's to state, and an enum here would be a second place to change it.
		color: text("color").$type<AgentColor>().notNull(),
		face: text("face").$type<AgentFace>().notNull(),
		// Null when nobody has chosen one, or somebody has cleared it. A system
		// agent with no model does not run; a crew agent's turns refuse.
		model: text("model"),
		prompt: text("prompt").notNull().default(""),
		// The built-in tools switched off for this agent, by key. What is off
		// rather than what is on, so a new tool reaches every existing agent.
		disabledTools: jsonb("disabled_tools").$type<string[]>().notNull().default([]),
		// Whether it may use its pod's sandbox. Off until an admin turns it on:
		// running commands is a bigger step than the other built-in tools.
		usesSandbox: boolean("uses_sandbox").notNull().default(false),
		// Who made it. Kept when they leave, so the record survives the person.
		createdById: uuid("created_by_id").references(() => user.id, { onDelete: "set null" }),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		// A composite foreign key is MATCH SIMPLE, so a system agent's null
		// `pod_id` is neither checked nor cascaded: deleting a pod leaves the
		// workspace's system agents alone. Deleting the workspace still takes
		// them, through the plain `workspace_id` reference above.
		foreignKey({
			columns: [table.podId, table.workspaceId],
			foreignColumns: [pod.id, pod.workspaceId],
			name: "agent_pod_workspace_fkey",
		}).onDelete("cascade"),
		// A row is a crew agent in a pod, or a system agent in none. Without
		// this, a nullable `pod_id` would also admit a pod-less crew agent,
		// which no pod permission reaches and no pod listing shows.
		check(
			"agent_placement_check",
			sql`(${table.systemAgentKey} is null) = (${table.podId} is not null)`,
		),
		// Scoped by pod, so they cover crew only; a system agent's null `pod_id`
		// makes every row distinct in them. What keeps there being one Scribe and
		// one Facilitator is `agent_system_agent_key_idx` below, and what keeps a
		// pod-less row from being crew is `agent_placement_check` above.
		uniqueIndex("agent_name_idx").on(table.podId, table.name),
		uniqueIndex("agent_handle_idx").on(table.podId, table.handle),
		uniqueIndex("agent_provisioned_key_idx").on(table.podId, table.provisionedKey),
		// One of each system agent per workspace. Crew never collide here: their
		// `system_agent_key` is null, and nulls are distinct in a btree index.
		// It is also the workspace-prefixed index "every agent in this workspace"
		// scans, so a second index on `workspace_id` alone would only cost writes.
		uniqueIndex("agent_system_agent_key_idx").on(table.workspaceId, table.systemAgentKey),
		uniqueIndex("agent_id_workspace_id_idx").on(table.id, table.workspaceId),
		index("agent_pod_id_idx").on(table.podId),
	],
);

export type PodRow = typeof pod.$inferSelect;
export type AgentRow = typeof agent.$inferSelect;
