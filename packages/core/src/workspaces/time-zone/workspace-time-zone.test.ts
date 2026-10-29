import { eq } from "drizzle-orm";
import { Context } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Routines } from "../../conversations/routines/routines.ts";
import { aRoutineOwner } from "../../conversations/routines/testing.ts";
import { conversationsForTests } from "../../conversations/testing.ts";
import { EventBus } from "../../database/events/bus.ts";
import { EventStore } from "../../database/events/store.ts";
import { workspace } from "../../database/schema.ts";
import { closeDatabase, onDatabase, type Promised } from "../../database/testing.ts";
import { onPostgresAs } from "../testing.ts";
import { WorkspaceTimeZone } from "./workspace-time-zone.ts";

/** Moving a workspace to another time zone, with its routines' schedules, against Postgres. */
describe.skipIf(!process.env.DATABASE_URL)(
	"a workspace's time zone, against Postgres",
	async () => {
		const conversations = await conversationsForTests(
			EventBus.inProcess({ store: EventStore.inMemory() }),
		);
		let workspaceId: string;
		let agentId: string;
		let timeZones: Promised<WorkspaceTimeZone.Interface>;
		let routines: Promised<Routines.Interface>;

		const atNine = (timezone: string) => ({
			kind: "cron" as const,
			schedule: { repeat: "cron" as const, expression: "0 9 * * *" },
			timezone,
		});

		afterAll(async () => {
			await closeDatabase();
		});

		beforeEach(async () => {
			let userId: string;
			({ workspaceId, agentId, userId } = await aRoutineOwner());
			await onDatabase((db) =>
				db
					.update(workspace)
					.set({ timeZone: "Australia/Sydney" })
					.where(eq(workspace.id, workspaceId)),
			);
			timeZones = onPostgresAs(userId)(Context.get(conversations, WorkspaceTimeZone.Service));
			routines = onPostgresAs(userId)(Context.get(conversations, Routines.Service));
		});

		it("moves the schedules in the workspace's zone, and leaves the ones set for another", async () => {
			const local = await routines.create(
				{ agentId },
				{ name: "Standup", instructions: "Ask.", triggers: [atNine("Australia/Sydney")] },
			);
			const paused = await routines.create(
				{ agentId },
				{
					name: "Paused standup",
					instructions: "Ask.",
					state: "paused",
					triggers: [atNine("Australia/Sydney")],
				},
			);
			const elsewhere = await routines.create(
				{ agentId },
				{ name: "London report", instructions: "Report.", triggers: [atNine("Europe/London")] },
			);
			expect(await timeZones.get({ workspace: workspaceId })).toEqual({
				timeZone: "Australia/Sydney",
				scheduledRoutines: 2,
			});

			await timeZones.change({ workspace: workspaceId, timeZone: "Asia/Tokyo" });

			expect(await timeZones.get({ workspace: workspaceId })).toEqual({
				timeZone: "Asia/Tokyo",
				scheduledRoutines: 2,
			});
			const moved = await routines.get({ agentId, routineId: local.routine.id });
			expect(moved.triggers).toEqual([
				expect.objectContaining({ timezone: "Asia/Tokyo", nextScheduledAt: expect.any(String) }),
			]);
			// Nine in Tokyo is midnight UTC.
			const [trigger] = moved.triggers;
			const nextScheduledAt = trigger?.kind === "cron" ? trigger.nextScheduledAt : null;
			expect(nextScheduledAt && new Date(nextScheduledAt).getUTCHours()).toBe(0);
			expect((await routines.get({ agentId, routineId: paused.routine.id })).triggers).toEqual([
				expect.objectContaining({ timezone: "Asia/Tokyo", nextScheduledAt: null }),
			]);
			expect((await routines.get({ agentId, routineId: elsewhere.routine.id })).triggers).toEqual([
				expect.objectContaining({ timezone: "Europe/London" }),
			]);
		});

		it("refuses a zone the database does not know, and stays where it was", async () => {
			await expect(
				timeZones.change({ workspace: workspaceId, timeZone: "Mars/Olympus" }),
			).rejects.toMatchObject({ _tag: "TimeZoneUnknown" });
			expect(await timeZones.get({ workspace: workspaceId })).toMatchObject({
				timeZone: "Australia/Sydney",
			});
		});
	},
);
