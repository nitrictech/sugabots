import type { NotificationLevel, QuietHours, RoutineRunNotifications } from "@sugabots/contracts";
import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { primaryKey, updatedStamp } from "../database/sql.ts";
import { agent, pod, user } from "../workspaces/sql.ts";

const notificationLevel = (name: string) => text(name).$type<NotificationLevel>();

const levelIsValid = (name: string, column: Parameters<typeof sql>[1]) =>
	check(name, sql`${column} in ('all', 'mentions', 'nothing')`);

/** What a person is notified about, once they have chosen. Without a row they get the defaults. */
export const notificationSettings = pgTable(
	"notification_settings",
	{
		userId: uuid("user_id")
			.primaryKey()
			.references(() => user.id, { onDelete: "cascade" }),
		level: notificationLevel("level").notNull(),
		pausedUntil: timestamp("paused_until", { withTimezone: true }),
		quietHours: jsonb("quiet_hours").$type<QuietHours>(),
		turnFailures: boolean("turn_failures").notNull().default(true),
		routineRuns: text("routine_runs")
			.$type<RoutineRunNotifications>()
			.notNull()
			.default("failures"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		levelIsValid("notification_settings_level_valid", table.level),
		check(
			"notification_settings_routine_runs_valid",
			sql`${table.routineRuns} in ('failures', 'all', 'none')`,
		),
	],
);

/**
 * What a person chose for one pod or one of a pod's bots: a level, in place of
 * the one above it, a mute until `mutedUntil`, or both.
 */
export const notificationOverride = pgTable(
	"notification_override",
	{
		id: primaryKey(),
		userId: uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		podId: uuid("pod_id").references(() => pod.id, { onDelete: "cascade" }),
		agentId: uuid("agent_id").references(() => agent.id, { onDelete: "cascade" }),
		level: notificationLevel("level"),
		mutedUntil: timestamp("muted_until", { withTimezone: true }),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		levelIsValid("notification_override_level_valid", table.level),
		check(
			"notification_override_chooses_something",
			sql`num_nonnulls(${table.level}, ${table.mutedUntil}) > 0`,
		),
		check(
			"notification_override_one_place",
			sql`num_nonnulls(${table.podId}, ${table.agentId}) = 1`,
		),
		uniqueIndex("notification_override_pod_idx")
			.on(table.userId, table.podId)
			.where(sql`${table.podId} is not null`),
		uniqueIndex("notification_override_agent_idx")
			.on(table.userId, table.agentId)
			.where(sql`${table.agentId} is not null`),
	],
);
