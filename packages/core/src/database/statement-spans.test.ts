import { sql } from "drizzle-orm";
import { Effect, ManagedRuntime, Tracer } from "effect";
import { Pool } from "pg";
import { afterAll, beforeEach, expect, it } from "vitest";
import { type Database, layer, query, transaction } from "./database.ts";

/**
 * Statement spans cross drizzle's lazy promises and the transaction bridge,
 * neither of which the types say anything about, so this runs against a real
 * Postgres and a tracer that records what it is asked to open.
 */

const url = process.env.DATABASE_URL;
if (!url) {
	throw new Error("DATABASE_URL is required. Copy .env.example to .env.");
}

const runtime = ManagedRuntime.make(layer(new Pool({ connectionString: url })));

afterAll(() => runtime.dispose());

let opened: Tracer.Span[] = [];
beforeEach(() => {
	opened = [];
});

const recording = Tracer.make({
	span(options) {
		const span = Tracer.nativeTracer.span(options);
		opened.push(span);
		return span;
	},
});

const traced = <A, E>(effect: Effect.Effect<A, E, Database>) =>
	runtime.runPromise(effect.pipe(Effect.withTracer(recording)));

const statements = () =>
	opened
		.filter((span) => span.kind === "client")
		.map((span) => ({
			name: span.name,
			text: span.attributes.get("db.query.text"),
			parent: span.parent._tag === "Some" ? span.parent.value.spanId : undefined,
			ended: span.status._tag === "Ended",
		}));

const outerSpanId = () => opened.find((span) => span.name === "outer")?.spanId;

it("opens a span per statement under the current span, SQL included", async () => {
	await traced(
		query(async (db) => {
			await db.execute(sql`select 1`);
			await db.execute(sql`select 2`);
		}).pipe(Effect.withSpan("outer")),
	);

	expect(statements()).toStrictEqual([
		{ name: "SELECT", text: "select 1", parent: outerSpanId(), ended: true },
		{ name: "SELECT", text: "select 2", parent: outerSpanId(), ended: true },
	]);
});

it("traces a query handed back unawaited, which drizzle only sends when awaited", async () => {
	await traced(query((db) => db.execute(sql`select 1`)).pipe(Effect.withSpan("outer")));

	expect(statements()).toStrictEqual([
		{ name: "SELECT", text: "select 1", parent: outerSpanId(), ended: true },
	]);
});

it("traces statements inside a transaction", async () => {
	await traced(
		transaction(query((db) => db.execute(sql`select 1`))).pipe(Effect.withSpan("outer")),
	);

	expect(statements()).toContainEqual({
		name: "SELECT",
		text: "select 1",
		parent: outerSpanId(),
		ended: true,
	});
});

it("traces nothing when there is no span to hang statements from", async () => {
	await traced(query((db) => db.execute(sql`select 1`)));

	expect(statements()).toStrictEqual([]);
});
