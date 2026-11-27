import { describe, expect, it } from "vitest";
import {
	collectBindings,
	declaredProofs,
	proofBoundaryViolations,
} from "./check-proof-boundaries.ts";

const coreService = "packages/core/src/chats/fixture.ts";
const proofNames = [
	"ReachesChat",
	"ReachesProject",
	"ActsForMember",
	"SignedByGitHubApp",
	"DoesStoredWork",
	"DeletionStarted",
	"ProjectDeletionStarted",
	"OwnsUnsentAttachment",
	"CallsWebhook",
];
const proofs = declaredProofs(
	proofNames.map((name) => `export interface ${name}<P> extends Proof<"${name}", [P]> {}`),
);

describe("proof boundary lint", () => {
	it.each(proofNames)("refuses an assertion to %s", (name) => {
		expect(proofBoundaryViolations(coreService, `value as ${name}<P>`, proofs)).toEqual([
			{ line: 1, rule: "no-proof-assertion" },
		]);
	});

	it.each([
		[
			"direct alias",
			"type Alias<P> = ActsForMember<P>;\nvalue as Alias<P>",
			"no-proof-assertion",
			2,
		],
		[
			"double assertion in a service",
			"value as unknown as ImportedAlias<P>",
			"no-double-assertion",
			1,
		],
		["prefix assertion to an alias", "<ImportedAlias<P>>value", "no-prefix-assertion", 1],
		[
			"aliased proof maker",
			'import { defineProof as dp } from "../proofs/proof.ts";\nconst { prove } = dp("made");',
			"proofs-only-in-proofs",
			1,
		],
		[
			"aliased principal factory",
			'import { authenticated as built } from "../principal.ts";\nconst { memberSession } = built;',
			"principals-only-in-authentication",
			1,
		],
		[
			"namespaced proof maker",
			'import * as proofs from "../proofs/proof.ts";\nconst { defineProof } = proofs;',
			"proofs-only-in-proofs",
			1,
		],
		[
			"namespaced principal factory",
			'import * as principals from "../principal.ts";\nconst { authenticated } = principals;',
			"principals-only-in-authentication",
			1,
		],
		[
			"dynamically imported proof maker",
			'const { defineProof } = await import("../proofs/proof.ts");',
			"proofs-only-in-proofs",
			1,
		],
		[
			"dynamically imported principal factory",
			'const { authenticated } = await import("../principal.ts");',
			"principals-only-in-authentication",
			1,
		],
	] as const)("refuses a %s", (_, source, rule, line) => {
		expect(proofBoundaryViolations(coreService, source, proofs)).toEqual([{ line, rule }]);
	});

	it.each([
		["union", "value as ReachesChat<P, C> | undefined", 1],
		["intersection", "value as ReachesChat<P, C> & object", 1],
		["type argument", "value as Readonly<ReachesChat<P, C>>", 1],
		["type operator", "value as readonly ReachesChat<P, C>[]", 1],
		["type query", "declare const realProof: ReachesChat<P, C>;\nvalue as typeof realProof", 2],
		[
			"inferred type query",
			'import { proveReachesChat } from "../proofs/reaches-chat.ts";\nfunction* operation() { const realProof = yield* proveReachesChat(p, c); return value as typeof realProof; }',
			2,
		],
		["conditional", "value as (T extends string ? ReachesChat<P, C> : never)", 1],
		[
			"imported alias",
			'import type { PlaceReached as Reach } from "./places.ts";\nvalue as Reach<P, J>',
			2,
		],
	] as const)("refuses a proof cast through a %s", (_, source, line) => {
		const bindings = collectBindings(
			new Map([
				[coreService, source],
				[
					"packages/core/src/proofs/reaches-chat.ts",
					"export const proveReachesChat = (p, c) => findChat(p, c);",
				],
				[
					"packages/core/src/chats/places.ts",
					"export type PlaceReached<P, J> = ReachesProject<P, J> | undefined;",
				],
			]),
		);
		expect(proofBoundaryViolations(coreService, source, proofs, bindings)).toEqual([
			{ line, rule: "no-proof-assertion" },
		]);
	});

	it("allows the defining modules to import their own constructors", () => {
		expect(
			proofBoundaryViolations(
				"packages/core/src/proofs/fixture.ts",
				'import { defineProof } from "./proof.ts";\nconst { prove } = defineProof("Test");',
				proofs,
			),
		).toEqual([]);
		expect(
			proofBoundaryViolations(
				"packages/core/src/authentication/fixture.ts",
				'import { authenticated } from "../principal.ts";\nauthenticated.memberSession(input);',
				proofs,
			),
		).toEqual([]);
	});
});
