import type {
	AssignableWorkspaceRole,
	BotColor,
	BotFace,
	BotShape,
	ProjectColor,
	SystemBotKey,
	WorkspaceRole,
} from "@sugabots/contracts";
import {
	ASSIGNABLE_WORKSPACE_ROLES,
	DEFAULT_TIME_ZONE,
	WORKSPACE_ROLES,
} from "@sugabots/contracts";
import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	boolean,
	check,
	primaryKey as compositePrimaryKey,
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
		/** When its setup was finished; null while it is still being set up. */
		setupCompletedAt: timestamp("setup_completed_at", { withTimezone: true }),
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

/**
 * A project: a long-running piece of work, made of its threads, led by one
 * bot (`lead_bot_id`) and worked on by the bots in `project_bot`.
 *
 * A row is one of two things. An ordinary project, which people make, find in
 * the directory and join (`default_of_bot_id` null). Or a bot's default
 * project (`default_of_bot_id` names the bot): the hidden project where the
 * bot's own threads live, led by that bot alone, with it as its only bot. It
 * is made with its bot by the `bot_default_project` trigger and deleted with
 * it; nobody joins it, and whoever reaches the bot reaches it (see
 * `authorization/access.ts`), so its `name`, `slug` and `visibility` are only
 * placeholders.
 *
 * `lead_bot_id` is null only on a project from before projects had leads that
 * had no bots then; making a project, or changing it, always sets one.
 */
export const project = pgTable(
	"project",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspace.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		slug: text("slug").notNull(),
		// One of the contract's project colour names, as `bot.color` is a bot's.
		// Null reads as the default colour.
		color: text("color").$type<ProjectColor>(),
		description: text("description"),
		visibility: text("visibility").$type<"public" | "private">().notNull().default("public"),
		// Who made it. Kept when they leave, so the record survives the person.
		createdById: uuid("created_by_id").references(() => user.id, { onDelete: "set null" }),
		/** The bot that works on the project and answers its threads unless another is asked. */
		leadBotId: uuid("lead_bot_id").references((): AnyPgColumn => bot.id, { onDelete: "set null" }),
		/** On a bot's default project: the bot, which it goes with. */
		defaultOfBotId: uuid("default_of_bot_id").references((): AnyPgColumn => bot.id, {
			onDelete: "cascade",
		}),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		check("project_visibility_check", sql`${table.visibility} in ('public', 'private')`),
		// A default project is led by its own bot.
		check(
			"project_default_led_by_its_bot",
			sql`${table.defaultOfBotId} is null or ${table.leadBotId} = ${table.defaultOfBotId}`,
		),
		// A default project's slug is never in an address, so it never takes one from a project people name.
		uniqueIndex("project_slug_idx")
			.on(table.workspaceId, table.slug)
			.where(sql`${table.defaultOfBotId} is null`),
		uniqueIndex("project_id_workspace_id_idx").on(table.id, table.workspaceId),
		uniqueIndex("project_default_of_bot_idx").on(table.defaultOfBotId),
		index("project_lead_bot_idx").on(table.leadBotId),
	],
);

/**
 * Who is in a project.
 *
 * These rows are the whole answer to who is in a project people made. A public
 * project is listed to everybody in the workspace, but its conversations are
 * reached only with a row: joining writes one. Every workspace admin has one in
 * every such project, and demoting them leaves their rows as they are. A bot's
 * default project has none: it is reached through its bot.
 *
 * There is no role here. What somebody may configure is their workspace role,
 * which lives on `workspace_member`. Adding a column here later is cheaper
 * than pretending to a distinction the product does not yet make.
 *
 * The administrators' rows are written by triggers, which Drizzle has no way
 * to declare, so they live in migrations and are named here because this is
 * where somebody checking what writes these rows looks:
 * `project_administrators` adds every owner and admin to a new project, and
 * `administrator_projects` adds a new owner or admin to every project; neither
 * touches a bot's default project. Both take
 * `lock_project_membership(workspace_id)`, as must anything that removes a row
 * on the strength of somebody's role, so a promotion cannot slip between them.
 */
export const projectMember = pgTable(
	"project_member",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id").notNull(),
		projectId: uuid("project_id").notNull(),
		userId: uuid("user_id").notNull(),
		createdAt: stamp("created_at"),
	},
	(table) => [
		foreignKey({
			columns: [table.projectId, table.workspaceId],
			foreignColumns: [project.id, project.workspaceId],
			name: "project_member_project_workspace_fkey",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.workspaceId, table.userId],
			foreignColumns: [workspaceMember.workspaceId, workspaceMember.userId],
			name: "project_member_workspace_member_fkey",
		}).onDelete("cascade"),
		uniqueIndex("project_member_idx").on(table.projectId, table.userId),
		// "Which projects can this person see", which is every sidebar load.
		index("project_member_user_id_idx").on(table.userId),
	],
);

/**
 * A bot: a name, a face, a prompt and the tools it may reach for.
 *
 * A row is one of three things: a bot people made (`system_bot_key` and
 * `assistant_of` both null), public or private by `visibility`; somebody's
 * Personal Assistant (`assistant_of` names them), only ever theirs; or a
 * system bot (`system_bot_key` names it), which works in the background for
 * the whole workspace and nobody talks to.
 *
 * Any may have no `model`, which means nobody has chosen one. That is a
 * state the product allows rather than a broken row: a system bot does not
 * run, and other bots' turns refuse with a reason naming it.
 *
 * `name` is unique per workspace among the bots people make, because a name
 * is how a person addresses a bot: `@Linear Handler` in a message has to mean
 * one of them. Every Personal Assistant may share one, as only its person
 * talks to it.
 *
 * `color`, `face` and `shape` are the whole avatar. Small columns rather than
 * an image, which is what lets a bot created at run time have a face at all.
 *
 * Every bot but a system bot has a default project, where its own threads
 * live, made with it by the `bot_default_project` trigger, which Drizzle has
 * no way to declare, in `20261119001412_default_projects_and_lead_bots`.
 */
export const bot = pgTable(
	"bot",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspace.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		// How the bot is addressed in a message: `@personal-assistant`.
		// Derived from the name unless an admin sets one; unique per workspace.
		handle: text("handle").notNull(),
		systemBotKey: text("system_bot_key").$type<SystemBotKey>(),
		// Whether everyone in the workspace sees the bot, or only its creator.
		visibility: text("visibility").$type<"public" | "private">().notNull().default("public"),
		// On a Personal Assistant: the one person who sees it and talks to it.
		assistantOf: uuid("assistant_of"),
		description: text("description"),
		// One of the contract's colour names. Not a Postgres enum: the palette is
		// the contract's to state, and an enum here would be a second place to change it.
		color: text("color").$type<BotColor>().notNull(),
		face: text("face").$type<BotFace>().notNull(),
		// Every bot made before shapes existed was a circle.
		shape: text("shape").$type<BotShape>().notNull().default("circle"),
		// Null when nobody has chosen one, or somebody has cleared it. A system
		// bot with no model does not run; a turn of a bot people talk to refuses.
		model: text("model"),
		prompt: text("prompt").notNull().default(""),
		// The built-in tools switched off for this bot, by key. What is off
		// rather than what is on, so a new tool reaches every existing bot.
		disabledTools: jsonb("disabled_tools").$type<string[]>().notNull().default([]),
		// Whether it may use its computer. Off until its creator or an admin
		// turns it on: running commands is a bigger step than the other built-in tools.
		usesComputer: boolean("uses_computer").notNull().default(false),
		// Whether it browses so people watching can follow, which is slower.
		naturalBrowsing: boolean("natural_browsing").notNull().default(false),
		// Who made it. Kept when they leave, so the record survives the person.
		createdById: uuid("created_by_id").references(() => user.id, { onDelete: "set null" }),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		check("bot_visibility_check", sql`${table.visibility} in ('public', 'private')`),
		// A Personal Assistant goes with its person's membership.
		foreignKey({
			columns: [table.workspaceId, table.assistantOf],
			foreignColumns: [workspaceMember.workspaceId, workspaceMember.userId],
			name: "bot_assistant_workspace_member_fkey",
		}).onDelete("cascade"),
		// How people address a bot, so one of each per workspace. System bots
		// and Personal Assistants are never addressed by others.
		uniqueIndex("bot_name_idx")
			.on(table.workspaceId, sql`lower(${table.name})`)
			.where(sql`${table.systemBotKey} is null and ${table.assistantOf} is null`),
		uniqueIndex("bot_handle_idx")
			.on(table.workspaceId, table.handle)
			.where(sql`${table.systemBotKey} is null and ${table.assistantOf} is null`),
		uniqueIndex("bot_assistant_idx")
			.on(table.workspaceId, table.assistantOf)
			.where(sql`${table.assistantOf} is not null`),
		// One of each system bot per workspace. Other bots never collide here: their
		// `system_bot_key` is null, and nulls are distinct in a btree index.
		// It is also the workspace-prefixed index "every bot in this workspace"
		// scans, so a second index on `workspace_id` alone would only cost writes.
		uniqueIndex("bot_system_bot_key_idx").on(table.workspaceId, table.systemBotKey),
		uniqueIndex("bot_id_workspace_id_idx").on(table.id, table.workspaceId),
	],
);

export type ProjectRow = typeof project.$inferSelect;
export type BotRow = typeof bot.$inferSelect;

/** A bot in a project. */
export const projectBot = pgTable(
	"project_bot",
	{
		workspaceId: uuid("workspace_id").notNull(),
		projectId: uuid("project_id").notNull(),
		botId: uuid("bot_id").notNull(),
		createdAt: stamp("created_at"),
	},
	(table) => [
		compositePrimaryKey({ columns: [table.projectId, table.botId] }),
		foreignKey({
			columns: [table.projectId, table.workspaceId],
			foreignColumns: [project.id, project.workspaceId],
			name: "project_bot_project_workspace_fkey",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.botId, table.workspaceId],
			foreignColumns: [bot.id, bot.workspaceId],
			name: "project_bot_bot_workspace_fkey",
		}).onDelete("cascade"),
		index("project_bot_bot_id_idx").on(table.botId),
	],
);

/** A bot a person pinned to their sidebar. */
export const pinnedBot = pgTable(
	"pinned_bot",
	{
		workspaceId: uuid("workspace_id").notNull(),
		userId: uuid("user_id").notNull(),
		botId: uuid("bot_id").notNull(),
		createdAt: stamp("created_at"),
	},
	(table) => [
		compositePrimaryKey({ columns: [table.userId, table.botId] }),
		foreignKey({
			columns: [table.workspaceId, table.userId],
			foreignColumns: [workspaceMember.workspaceId, workspaceMember.userId],
			name: "pinned_bot_workspace_member_fkey",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.botId, table.workspaceId],
			foreignColumns: [bot.id, bot.workspaceId],
			name: "pinned_bot_bot_workspace_fkey",
		}).onDelete("cascade"),
		index("pinned_bot_bot_id_idx").on(table.botId),
	],
);
