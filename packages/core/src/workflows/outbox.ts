export * as Outbox from "./outbox.ts";

import { eq, lt, sql } from "drizzle-orm";
import { Context, Duration, Effect, type Exit, Layer, Schema } from "effect";
import { DurableDeferred, type Workflow, WorkflowEngine } from "effect/unstable/workflow";
import { afterCommit, Database, query, transaction } from "../database/database.ts";
import { workflowOutbox } from "./sql.ts";

/**
 * Signals and interrupts that follow a domain write, such as an approval
 * decision completing a turn's deferred or a person cancelling a turn.
 *
 * The message is sent only once the write commits, so the engine never hears
 * of a write that rolled back. It is recorded in the write's transaction, sent
 * after commit, and deleted when delivered; `reconcile` sends again anything a
 * crash left behind. Sending twice is harmless: a deferred keeps its first
 * value, and interrupting twice is interrupting once.
 */
export interface Interface {
	readonly signal: <Success extends Schema.Constraint, Error extends Schema.Constraint>(message: {
		readonly workflow: Workflow.Any;
		readonly executionId: string;
		readonly deferred: DurableDeferred.DurableDeferred<Success, Error>;
		readonly exit: Exit.Exit<Success["Type"], Error["Type"]>;
	}) => Effect.Effect<void>;
	readonly interrupt: (message: {
		readonly workflow: Workflow.Any;
		readonly executionId: string;
	}) => Effect.Effect<void>;
	/** Sends messages a crash left undelivered. Run periodically. */
	readonly reconcile: Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Outbox") {}

/** How long a message may wait before `reconcile` sends it again. */
const UNDELIVERED_AFTER = Duration.seconds(30);

type Row = typeof workflowOutbox.$inferSelect;

/** Messages for these workflows, which `reconcile` finds again by name. */
export const make = (workflows: ReadonlyArray<Workflow.Any>) =>
	Effect.gen(function* () {
		const database = yield* Database;
		const engine = yield* WorkflowEngine.WorkflowEngine;
		const byName = new Map(workflows.map((workflow) => [workflow._tag, workflow]));
		const provide = Effect.provideService(Database, database);

		const deliver = (row: Row) =>
			Effect.gen(function* () {
				const workflow = byName.get(row.workflow);
				if (!workflow)
					return yield* Effect.die(new Error(`No outbox is registered for "${row.workflow}"`));
				if (row.kind === "interrupt") {
					yield* engine.interrupt(workflow, row.executionId);
				} else {
					yield* engine.deferredDone(passThrough(row.deferred ?? ""), {
						workflowName: workflow._tag,
						executionId: row.executionId,
						deferredName: row.deferred ?? "",
						exit: decodeEncodedExit(row.exit),
					});
				}
				yield* query((db) => db.delete(workflowOutbox).where(eq(workflowOutbox.id, row.id)));
			}).pipe(provide);

		const record = (values: typeof workflowOutbox.$inferInsert) =>
			transaction(
				Effect.gen(function* () {
					const [row] = yield* query((db) => db.insert(workflowOutbox).values(values).returning());
					if (row) yield* afterCommit(deliver(row));
				}),
			).pipe(provide);

		return Service.of({
			signal: ({ workflow, executionId, deferred, exit }) =>
				record({
					kind: "signal",
					workflow: workflow._tag,
					executionId,
					deferred: deferred.name,
					exit: Schema.encodeUnknownSync(
						Schema.toCodecJson(deferred.exitSchema) as unknown as Schema.Codec<unknown, unknown>,
					)(exit),
				}),
			interrupt: ({ workflow, executionId }) =>
				record({ kind: "interrupt", workflow: workflow._tag, executionId }),
			reconcile: query((db) =>
				db
					.select()
					.from(workflowOutbox)
					.where(
						lt(
							workflowOutbox.createdAt,
							sql`now() - make_interval(secs => ${Duration.toSeconds(UNDELIVERED_AFTER)})`,
						),
					),
			).pipe(
				Effect.flatMap((rows) => Effect.forEach(rows, deliver, { discard: true })),
				provide,
			),
		});
	});

export const layer = (workflows: ReadonlyArray<Workflow.Any>) =>
	Layer.effect(Service, make(workflows));

/**
 * Sends an exit already encoded with the real deferred's schema. `Schema.Any`
 * encodes values unchanged, so the workflow receives exactly the encoding the
 * caller made, and decodes it with the deferred it awaits.
 */
const passThrough = (name: string) =>
	DurableDeferred.make(name, { success: Schema.Any, error: Schema.Any });

const decodeEncodedExit = Schema.decodeUnknownSync(
	Schema.toCodecJson(Schema.Exit(Schema.Any, Schema.Any, Schema.Defect())),
) as (encoded: unknown) => Exit.Exit<unknown, unknown>;
