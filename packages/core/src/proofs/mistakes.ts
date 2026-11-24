/**
 * Near-misses with proofs, principals and tiers, one per line under
 * `@ts-expect-error`. Type-checked and never run or imported: if a change makes
 * one of these lines compile, the unused `@ts-expect-error` fails the
 * typecheck. Add a line for every near-miss found in review.
 *
 * The proofs and services here are stand-ins with the shapes the real ones
 * take, declared so the checks don't depend on any one prover.
 *
 * The Effect language service's own report of an undeclared error is off
 * here, as `@ts-expect-error` doesn't silence it and the mistake is the point.
 */
// @effect-diagnostics missingEffectError:off

import { OperationContract } from "@sugabots/contracts/operations";
import { Context, Effect, Layer, Schema } from "effect";
import { defineOperation } from "../operations/operation.ts";
import type { BotForAsker, MemberSession, Principal } from "../principal.ts";
import { processLayer, Tier } from "../tiers.ts";
import { defineProof, type Named, named, type Proof } from "./proof.ts";

interface ReachesProject<P, J> extends Proof<"ReachesProject", [P, J]> {
	readonly project: Named<J, string>;
}
interface ReachesChat<P, C> extends Proof<"ReachesChat", [P, C]> {
	readonly chat: Named<C, string>;
}
interface CanTakePart<P, C> extends Proof<"CanTakePart", [P, C]> {
	readonly reach: ReachesChat<P, C>;
}
interface CanManageChats<P, C> extends Proof<"CanManageChats", [P, C]> {
	readonly reach: ReachesChat<P, C>;
}
interface CanManageProject<P, J> extends Proof<"CanManageProject", [P, J]> {
	readonly reach: ReachesProject<P, J>;
}
interface HasMembership<P, W> extends Proof<"HasMembership", [P, W]> {
	readonly role: "owner" | "admin" | "editor" | "viewer";
}
interface Approved<T> extends Proof<"Approved", [T]> {}

declare const chats: {
	readonly setResolved: <P, C>(
		reach: ReachesChat<P, C>,
		resolved: boolean,
		access: CanTakePart<P, C>,
	) => Effect.Effect<void>;
	readonly rename: <P, C>(
		chat: Named<C, string>,
		access: CanManageChats<P, C>,
	) => Effect.Effect<void>;
	readonly post: <P, C>(chat: Named<C, string>, access: CanTakePart<P, C>) => Effect.Effect<void>;
};
declare const projects: {
	readonly archive: <P, J>(
		reach: ReachesProject<P, J>,
		access: CanManageProject<P, J>,
	) => Effect.Effect<void>;
};
declare const memberships: {
	readonly promote: <P, W>(membership: HasMembership<P, W>) => Effect.Effect<void>;
};
declare const toolCalls: {
	readonly run: <T>(toolCall: Named<T, string>, approved: Approved<T>) => Effect.Effect<void>;
};
declare const proveReachesChat: <P, C>(
	principal: Named<P, Principal>,
	chat: Named<C, string>,
) => Effect.Effect<ReachesChat<P, C>>;
declare const proveReachesProject: <P, J>(
	principal: Named<P, Principal>,
	project: Named<J, string>,
) => Effect.Effect<ReachesProject<P, J>>;
declare const proveCanTakePart: <P, C>(reach: ReachesChat<P, C>) => CanTakePart<P, C>;
declare const proveCanManageProject: <P, J>(reach: ReachesProject<P, J>) => CanManageProject<P, J>;
declare const proveHasMembership: <P, W>(
	principal: Named<P, Principal>,
	workspace: Named<W, string>,
) => Effect.Effect<HasMembership<P, W>>;
declare const proveApproved: <T>(toolCall: Named<T, string>) => Effect.Effect<Approved<T>>;

declare const principal: Principal;
declare const chatId: string;
declare const otherChatId: string;

// What `defineProof` makes fits the proof's interface, for the same names only.
const ReachesChatProof = defineProof("ReachesChat");
export const proveHere = <P, C>(principal: Named<P, Principal>, chat: Named<C, string>) => {
	const proof: ReachesChat<P, C> = ReachesChatProof.prove([principal, chat], { chat });
	// @ts-expect-error
	const swapped: ReachesChat<C, P> = ReachesChatProof.prove([principal, chat], { chat });
	// @ts-expect-error
	const otherKind: CanTakePart<P, C> = ReachesChatProof.prove([principal, chat], { reach: proof });
	return [proof, swapped, otherKind];
};

export const mistakes = named(principal, chatId, otherChatId, (principal, chatA, chatB) =>
	Effect.gen(function* () {
		const reachA = yield* proveReachesChat(principal, chatA);
		const reachB = yield* proveReachesChat(principal, chatB);
		const canTakePartA = proveCanTakePart(reachA);

		// A raw chat id handed to a service that wants a named one.
		// @ts-expect-error
		yield* chats.rename(chatId, canTakePartA);

		// A proof about chat A used for chat B.
		// @ts-expect-error
		yield* chats.setResolved(reachB, true, canTakePartA);

		// `CanTakePart` where `CanManageChats` is needed.
		// @ts-expect-error
		yield* chats.rename(chatA, canTakePartA);

		// A spread copy of a named value, with another value.
		// @ts-expect-error
		yield* chats.post({ ...chatA, value: otherChatId }, canTakePartA);

		yield* chats.post(chatA, canTakePartA);

		yield* chats.setResolved(reachA, true, canTakePartA);
	}),
);

export const membershipMistakes = named(principal, "workspace", (principal, workspace) =>
	Effect.gen(function* () {
		const membership = yield* proveHasMembership(principal, workspace);

		// A spread copy of `HasMembership` with another role.
		// @ts-expect-error
		yield* memberships.promote({ ...membership, role: "owner" });

		yield* memberships.promote(membership);
	}),
);

// A named value returned out of `named`.
// @ts-expect-error
export const escaped = named(chatId, (chat) => Effect.succeed(chat));

export const projectMistakes = named(
	principal,
	"project",
	"other project",
	(principal, project, otherProject) =>
		Effect.gen(function* () {
			const reach = yield* proveReachesProject(principal, project);
			const otherReach = yield* proveReachesProject(principal, otherProject);

			// A `ReachesProject` for project J paired with a permission for J′.
			// @ts-expect-error
			yield* projects.archive(reach, proveCanManageProject(otherReach));

			yield* projects.archive(reach, proveCanManageProject(reach));
		}),
);

export const approvalMistakes = named("tool call", "other tool call", (toolCall, otherToolCall) =>
	Effect.gen(function* () {
		const approved = yield* proveApproved(toolCall);

		// `Approved<T1>` used for T2.
		// @ts-expect-error
		yield* toolCalls.run(otherToolCall, approved);

		yield* toolCalls.run(toolCall, approved);
	}),
);

declare const memberOnly: (principal: MemberSession) => Effect.Effect<void>;
declare const botForAsker: BotForAsker;

// A `MemberSession`-only operation called with a `BotForAsker`.
// @ts-expect-error
export const botAsMember = memberOnly(botForAsker);

// Building a `Principal` literal.
// @ts-expect-error
export const forged: MemberSession = { _tag: "MemberSession", member: "someone" };

declare const session: MemberSession;
// A spread copy of a principal, with another member.
// @ts-expect-error
export const copied: MemberSession = { ...session, member: "someone else" };

class CurrentRequest extends Context.Service<CurrentRequest, { readonly id: string }>()(
	"@sugabots/core/mistakes/CurrentRequest",
) {
	declare readonly [Tier]: "request";
}
class Registry extends Context.Service<Registry, { readonly size: number }>()(
	"@sugabots/core/mistakes/Registry",
) {
	declare readonly [Tier]: "process";
}
class Lookup extends Context.Service<Lookup, { readonly describe: Effect.Effect<void> }>()(
	"@sugabots/core/mistakes/Lookup",
) {
	declare readonly [Tier]: "process";
}

// `processLayer` over a layer that needs a request-tier service.
export const capturesRequest = processLayer(
	// @ts-expect-error
	Layer.effect(
		Lookup,
		Effect.gen(function* () {
			const request = yield* CurrentRequest;
			return { describe: Effect.log(request.id) };
		}),
	),
);

export const processOnly = processLayer(
	Layer.effect(
		Lookup,
		Effect.gen(function* () {
			const registry = yield* Registry;
			return { describe: Effect.log(registry.size) };
		}),
	),
);

const setResolved = OperationContract.make("chats.setResolved", {
	description: "Mark this chat resolved, or reopen it.",
	input: Schema.Struct({ chatId: Schema.String, resolved: Schema.Boolean }),
	output: Schema.Void,
	errors: [],
	changes: true,
});

// An operation's body failing with an error its contract doesn't list.
// @ts-expect-error
export const undeclaredError = defineOperation(setResolved, () => Effect.fail("refused"));

// An operation's body reading an input field its contract doesn't have.
// @ts-expect-error
export const unknownInput = defineOperation(setResolved, (_, input) => Effect.log(input.chatName));

export const declared = defineOperation(setResolved, (_, input) => Effect.log(input.chatId));
