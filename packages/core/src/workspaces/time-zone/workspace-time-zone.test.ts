import type { InputOf } from "@sugabots/contracts/operations";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { lockTriggers } from "../../chats/automations/automation.ts";
import { anAutomationAdmin, automationsAs } from "../../chats/automations/testing.ts";
import { chatServicesForTests } from "../../chats/testing.ts";
import { query } from "../../database/database.ts";
import { EventBus } from "../../database/events/bus.ts";
import { inMemoryEventStore } from "../../database/events/testing.ts";
import { automation, automationTrigger, workspace } from "../../database/schema.ts";
import { closeDatabase, holdTransaction, onDatabase } from "../../database/testing.ts";
import { type CallOperation, servedOperations } from "../../operations/testing.ts";
import { authenticators, principals } from "../../proofs/world.test-support.ts";

/** Moving a workspace to another time zone, with its automations' routines, against Postgres. */
describe.skipIf(!process.env.DATABASE_URL)(
	"a workspace's time zone, against Postgres",
	async () => {
		const services = await chatServicesForTests(
			EventBus.inProcess({ store: inMemoryEventStore() }),
		);
		let callOperation: CallOperation;
		let signedIn: ReturnType<typeof principals>;
		let workspaceId: string;
		let ownProjectId: string;
		let timeZones: TimeZonesAs;
		let automations: ReturnType<typeof automationsAs>;

		const atNine = (timezone: string) => ({
			kind: "routine" as const,
			schedule: { repeat: "cron" as const, expression: "0 9 * * *" },
			timezone,
		});

		beforeAll(async () => {
			// The registry takes the time zone service from the chat services, as `index.ts` does.
			callOperation = await servedOperations({ chats: services });
			signedIn = principals(await authenticators());
		});

		afterAll(async () => {
			await closeDatabase();
		});

		/** The time zone operations, called for `memberId` signed in. */
		const timeZonesAs = async (memberId: string) => {
			const principal = await signedIn.member(memberId);
			return {
				get: (input: InputOf<"workspaces.timeZone">) =>
					callOperation(principal, "workspaces.timeZone", input),
				change: (input: InputOf<"workspaces.changeTimeZone">) =>
					callOperation(principal, "workspaces.changeTimeZone", input),
			};
		};
		type TimeZonesAs = Awaited<ReturnType<typeof timeZonesAs>>;

		beforeEach(async () => {
			let memberId: string;
			({ workspaceId, memberId, ownProjectId } = await anAutomationAdmin());
			await onDatabase((db) =>
				db
					.update(workspace)
					.set({ timeZone: "Australia/Sydney" })
					.where(eq(workspace.id, workspaceId)),
			);
			timeZones = await timeZonesAs(memberId);
			automations = automationsAs(callOperation, memberId);
		});

		it("moves the routines in the workspace's zone, and leaves the ones set for another", async () => {
			const local = await automations.create(
				{ projectId: ownProjectId },
				{ name: "Standup", instructions: "Ask.", triggers: [atNine("Australia/Sydney")] },
			);
			const paused = await automations.create(
				{ projectId: ownProjectId },
				{
					name: "Paused standup",
					instructions: "Ask.",
					state: "paused",
					triggers: [atNine("Australia/Sydney")],
				},
			);
			const elsewhere = await automations.create(
				{ projectId: ownProjectId },
				{ name: "London report", instructions: "Report.", triggers: [atNine("Europe/London")] },
			);
			expect(await timeZones.get({ workspace: workspaceId })).toEqual({
				timeZone: "Australia/Sydney",
				automationsWithRoutines: 2,
			});

			await timeZones.change({ workspace: workspaceId, timeZone: "Asia/Tokyo" });

			expect(await timeZones.get({ workspace: workspaceId })).toEqual({
				timeZone: "Asia/Tokyo",
				automationsWithRoutines: 2,
			});
			const listed = await automations.list({ projectId: ownProjectId });
			const triggersOf = (automationId: string) => {
				const found = listed.find((automation) => automation.id === automationId);
				return found && "triggers" in found ? found.triggers : undefined;
			};
			const moved = triggersOf(local.automation.id);
			expect(moved).toEqual([
				expect.objectContaining({ timezone: "Asia/Tokyo", nextScheduledAt: expect.any(String) }),
			]);
			// Nine in Tokyo is midnight UTC.
			const [trigger] = moved ?? [];
			const nextScheduledAt = trigger?.kind === "routine" ? trigger.nextScheduledAt : null;
			expect(nextScheduledAt && new Date(nextScheduledAt).getUTCHours()).toBe(0);
			expect(triggersOf(paused.automation.id)).toEqual([
				expect.objectContaining({ timezone: "Asia/Tokyo", nextScheduledAt: null }),
			]);
			expect(triggersOf(elsewhere.automation.id)).toEqual([
				expect.objectContaining({ timezone: "Europe/London" }),
			]);
		});

		it("waits for an automation's trigger lock and moves its routine using the committed state", async () => {
			const created = await automations.create(
				{ projectId: ownProjectId },
				{ name: "Standup", instructions: "Ask.", triggers: [atNine("Australia/Sydney")] },
			);
			const automationId = created.automation.id;
			const pausing = holdTransaction(
				lockTriggers(automationId),
				query((db) =>
					db.update(automation).set({ state: "paused" }).where(eq(automation.id, automationId)),
				),
				{ separatePostgresSession: true },
			);
			await pausing.held;

			const moving = timeZones.change({ workspace: workspaceId, timeZone: "Asia/Tokyo" });
			const observed = new AbortController();
			try {
				await Promise.race([
					pausing.waitForWaiters(1, observed.signal),
					moving.then(() => {
						throw new Error("The move finished before the routine was paused");
					}),
				]);
			} finally {
				observed.abort();
				try {
					await pausing.release();
				} finally {
					await moving;
				}
			}

			const [routine] = await onDatabase((db) =>
				db.select().from(automationTrigger).where(eq(automationTrigger.automationId, automationId)),
			);
			expect(routine).toMatchObject({
				settings: { timezone: "Asia/Tokyo" },
				nextScheduledAt: null,
			});
		});

		it("refuses a zone that isn't one, and stays where it was", async () => {
			await expect(
				timeZones.change({ workspace: workspaceId, timeZone: "Mars/Olympus" }),
			).rejects.toThrow("workspaces.changeTimeZone was called with an input its contract refuses");
			expect(await timeZones.get({ workspace: workspaceId })).toMatchObject({
				timeZone: "Australia/Sydney",
			});
		});
	},
);
