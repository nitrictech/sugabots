/**
 * Named values and proofs: how the core shows the type checker that access was
 * checked for exactly the values about to be acted on.
 *
 * 1. `named(principal, input.chatId, (principal, chat) => …)` gives each value
 *    a name only the type checker sees, different for every value and every
 *    run, and readable only while the effect the callback returns runs.
 * 2. A prover checks a fact about named values and returns a `Proof` of it,
 *    such as `ReachesChat<P, C>`. Each kind of proof is made by one prover, in
 *    one file in this directory, which keeps the result of `defineProof` to
 *    itself.
 * 3. A service demands proofs about its exact arguments. Shared type
 *    parameters make a proof about one chat unusable for another.
 *
 * The types stop a mismatched proof being passed; the runtime checks stop a
 * named value or proof being used after its operation ended, which a closure
 * can hide from the types. Neither checks a service's SQL.
 *
 * This file is the only one allowed to assert a proof's type (lint:
 * `no-proof-assertion`).
 */

import { Effect } from "effect";

/**
 * One run of {@link named}'s effect. Its named values, and proofs about them,
 * may be read only while `running` is true.
 */
interface NamingRun {
	running: boolean;
}

/** The key of a type-only field that makes a name invariant. Never exists at runtime. */
declare const nameKey: unique symbol;

/** The key of a type-only field that makes a proof invariant in what it is about. */
declare const aboutKey: unique symbol;

/**
 * A named value or proof was read after the operation that named its values
 * ended. A defect: proofs and named values belong to one operation, so work
 * that outlives it keeps ids and proves again.
 */
// biome-ignore lint/plugin/errors-implement-domain-error: Reading an expired proof is a defect in the caller.
export class NamedValueReadAfterOperation extends Error {
	override readonly name = "NamedValueReadAfterOperation";
	constructor() {
		super(
			"A named value or proof was read after the operation that named it ended. Keep ids in work that outlives an operation, and prove again where it runs.",
		);
	}
}

/**
 * `value` under the name `Name`, which only the type checker sees.
 *
 * Invariant in `Name`, so one name never stands for another. The private field
 * means a copy made by spreading (`{ ...chat, value: otherChatId }`) is not a
 * `Named`. Only {@link named} makes one: the class is exported as a type.
 */
class Named<in out Name, out Value> {
	declare readonly [nameKey]: (name: Name) => Name;
	readonly #value: Value;
	readonly #run: NamingRun;

	constructor(value: Value, run: NamingRun) {
		this.#value = value;
		this.#run = run;
		Object.freeze(this);
	}

	/** The value. A defect once the operation that named it has ended. */
	get value(): Value {
		Named.requireRunning(this);
		return this.#value;
	}

	/** Throws {@link NamedValueReadAfterOperation} once `named`'s run has ended. */
	static requireRunning(named: AnyNamed): void {
		if (!named.#run.running) throw new NamedValueReadAfterOperation();
	}
}

export type { Named };

// biome-ignore lint/suspicious/noExplicitAny: `any` matches a name of any type, which `unknown` can't, as `Named` is invariant in it.
type AnyNamed = Named<any, unknown>;

/** The names of a tuple of named values, in order. */
type NamesOf<Values extends readonly AnyNamed[]> = {
	-readonly [Index in keyof Values]: Values[Index] extends Named<infer Name, unknown>
		? Name
		: never;
};

/**
 * A fact of kind `Kind`, checked about the named values whose names are
 * `About`. Declare each kind as an interface extending this one, with the
 * fields its check found:
 *
 * ```ts
 * export interface CanTakePart<P, C> extends Proof<"CanTakePart", [P, C]> {
 * 	readonly reach: ReachesChat<P, C>;
 * }
 * ```
 *
 * The private field means only `defineProof(...).prove` makes one, and a copy
 * with a field changed is not one. The kind and every field are readable only
 * while the operation that named its values runs.
 */
class Proof<in out Kind extends string, in out About extends readonly unknown[]> {
	declare readonly [aboutKey]: (about: About) => About;
	readonly #kind: Kind;
	readonly #about: readonly AnyNamed[];

	constructor(kind: Kind, about: readonly AnyNamed[]) {
		this.#kind = kind;
		this.#about = about;
	}

	get kind(): Kind {
		Proof.requireRunning(this);
		return this.#kind;
	}

	/** Throws {@link NamedValueReadAfterOperation} once any value `proof` is about has expired. */
	// biome-ignore lint/suspicious/noExplicitAny: `any` matches a proof of any kind, about anything, which `unknown` can't, as `Proof` is invariant in both.
	static requireRunning(proof: Proof<any, any>): void {
		for (const named of proof.#about) Named.requireRunning(named);
	}
}

export type { Proof };

/**
 * The maker of one kind of proof. A prover's file calls this once and keeps
 * the result to itself, so that file is the only place the kind is made
 * (lint: `proofs-only-in-proofs`).
 */
export const defineProof = <const Kind extends string>(kind: Kind) => ({
	/**
	 * A proof that the fact `Kind` holds for the named values `about`, with
	 * what the check found as `fields`. Each field is read through a getter
	 * that refuses once any of `about` has expired.
	 */
	prove: <const About extends readonly AnyNamed[], Fields extends object>(
		about: About,
		fields: Fields,
	): Proof<Kind, NamesOf<About>> & Readonly<Fields> => {
		const proof = new ProvenFields(kind, about, fields);
		return Object.freeze(proof) as Proof<Kind, NamesOf<About>> & Readonly<Fields>;
	},
});

/** A proof whose fields are getters that check its named values are still readable. */
class ProvenFields<Kind extends string> extends Proof<Kind, readonly unknown[]> {
	constructor(kind: Kind, about: readonly AnyNamed[], fields: object) {
		super(kind, about);
		for (const [field, value] of Object.entries(fields)) {
			Object.defineProperty(this, field, {
				enumerable: true,
				get: () => {
					Proof.requireRunning(this);
					return value;
				},
			});
		}
	}
}

type NamedBody<Values extends readonly unknown[], Success, Failure, Services> = (
	...named: Values
) => Effect.Effect<Success, Failure, Services>;

/**
 * Names each of `values` for one run of `body`'s effect. Each run makes fresh
 * names: running the returned effect again never makes old named values
 * readable again. Reads of the named values, and of proofs about them, are
 * defects once the effect ends, whether it succeeded, failed or was
 * interrupted. Nested runs end on their own.
 *
 * `body` is generic in each name, so a named value can't be returned out of
 * `named` with its name: the name would escape its scope.
 */
export function named<A, Success, Failure, Services>(
	a: A,
	body: <NameA>(a: Named<NameA, A>) => Effect.Effect<Success, Failure, Services>,
): Effect.Effect<Success, Failure, Services>;
export function named<A, B, Success, Failure, Services>(
	a: A,
	b: B,
	body: <NameA, NameB>(
		a: Named<NameA, A>,
		b: Named<NameB, B>,
	) => Effect.Effect<Success, Failure, Services>,
): Effect.Effect<Success, Failure, Services>;
export function named<A, B, C, Success, Failure, Services>(
	a: A,
	b: B,
	c: C,
	body: <NameA, NameB, NameC>(
		a: Named<NameA, A>,
		b: Named<NameB, B>,
		c: Named<NameC, C>,
	) => Effect.Effect<Success, Failure, Services>,
): Effect.Effect<Success, Failure, Services>;
export function named<A, B, C, D, Success, Failure, Services>(
	a: A,
	b: B,
	c: C,
	d: D,
	body: <NameA, NameB, NameC, NameD>(
		a: Named<NameA, A>,
		b: Named<NameB, B>,
		c: Named<NameC, C>,
		d: Named<NameD, D>,
	) => Effect.Effect<Success, Failure, Services>,
): Effect.Effect<Success, Failure, Services>;
export function named<A, B, C, D, E, Success, Failure, Services>(
	a: A,
	b: B,
	c: C,
	d: D,
	e: E,
	body: <NameA, NameB, NameC, NameD, NameE>(
		a: Named<NameA, A>,
		b: Named<NameB, B>,
		c: Named<NameC, C>,
		d: Named<NameD, D>,
		e: Named<NameE, E>,
	) => Effect.Effect<Success, Failure, Services>,
): Effect.Effect<Success, Failure, Services>;
export function named(
	...valuesAndBody: readonly unknown[]
): Effect.Effect<unknown, unknown, unknown> {
	const values = valuesAndBody.slice(0, -1);
	const body = valuesAndBody.at(-1) as NamedBody<readonly AnyNamed[], unknown, unknown, unknown>;
	return Effect.suspend(() => {
		const run: NamingRun = { running: true };
		// The overloads above give each call its body's own types; this one only passes them on.
		// @effect-diagnostics-next-line anyUnknownInErrorContext:off
		return body(...values.map((value) => new Named(value, run))).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					run.running = false;
				}),
			),
		);
	});
}
