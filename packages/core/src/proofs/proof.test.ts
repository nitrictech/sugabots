import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import {
	defineProof,
	type Named,
	NamedValueReadAfterOperation,
	named,
	type Proof,
} from "./proof.ts";

interface ChatChecked<C> extends Proof<"ChatChecked", [C]> {
	readonly note: string;
}
const ChatChecked = defineProof("ChatChecked");
const proveChatChecked = <C>(chat: Named<C, string>): ChatChecked<C> =>
	ChatChecked.prove([chat], { note: "checked" });

/** The defect `read` dies with when run on its own, or `undefined` if it succeeds. */
const defectOf = (read: () => unknown) => {
	const exit = Effect.runSyncExit(Effect.sync(read));
	return Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
};

describe("named", () => {
	it("lets the body read its named values and proofs", () => {
		const read = named("chat-1", (chat) =>
			Effect.sync(() => {
				const proof = proveChatChecked(chat);
				return [chat.value, proof.kind, proof.note];
			}),
		);

		expect(Effect.runSync(read)).toEqual(["chat-1", "ChatChecked", "checked"]);
	});

	it("refuses reads of named values and proofs once the body has succeeded", () => {
		const [readValue, readProof, readKind] = Effect.runSync(
			named("chat-1", (chat) =>
				Effect.sync(() => {
					const proof = proveChatChecked(chat);
					return [() => chat.value, () => proof.note, () => proof.kind] as const;
				}),
			),
		);

		expect(defectOf(readValue)).toBeInstanceOf(NamedValueReadAfterOperation);
		expect(defectOf(readProof)).toBeInstanceOf(NamedValueReadAfterOperation);
		expect(defectOf(readKind)).toBeInstanceOf(NamedValueReadAfterOperation);
	});

	it("refuses reads once the body has failed", () => {
		let readLater: () => unknown = () => undefined;
		const exit = Effect.runSyncExit(
			named("chat-1", (chat) => {
				readLater = () => chat.value;
				return Effect.fail("refused");
			}),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		expect(defectOf(readLater)).toBeInstanceOf(NamedValueReadAfterOperation);
	});

	it("refuses reads once the body has been interrupted", async () => {
		const readLater = await Effect.runPromise(
			Effect.gen(function* () {
				const started = yield* Deferred.make<() => unknown>();
				const fiber = yield* Effect.forkChild(
					named("chat-1", (chat) =>
						Deferred.succeed(started, () => chat.value).pipe(Effect.andThen(Effect.never)),
					),
				);
				const read = yield* Deferred.await(started);
				expect(read()).toBe("chat-1");
				yield* Fiber.interrupt(fiber);
				return read;
			}),
		);

		expect(defectOf(readLater)).toBeInstanceOf(NamedValueReadAfterOperation);
	});

	it("ends a nested run on its own, leaving the outer one readable", () => {
		const result = Effect.runSync(
			named("chat-1", (outer) =>
				Effect.gen(function* () {
					const readInner = yield* named("chat-2", (inner) => Effect.succeed(() => inner.value));
					return { inner: defectOf(readInner), outer: outer.value };
				}),
			),
		);

		expect(result.inner).toBeInstanceOf(NamedValueReadAfterOperation);
		expect(result.outer).toBe("chat-1");
	});

	it("makes fresh names on each run, never reviving an earlier run's", () => {
		const reads: Array<() => unknown> = [];
		const run = named("chat-1", (chat) =>
			Effect.sync(() => {
				reads.push(() => chat.value);
				const earlier = reads[0];
				return reads.length > 1 && earlier ? defectOf(earlier) : chat.value;
			}),
		);

		expect(Effect.runSync(run)).toBe("chat-1");
		expect(Effect.runSync(run)).toBeInstanceOf(NamedValueReadAfterOperation);
	});

	it("freezes named values and proofs", () => {
		const frozen = Effect.runSync(
			named("chat-1", (chat) =>
				Effect.sync(() => [Object.isFrozen(chat), Object.isFrozen(proveChatChecked(chat))]),
			),
		);

		expect(frozen).toEqual([true, true]);
	});
});
