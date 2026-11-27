import { ActionForbidden, ResourceHidden, TurnEnded } from "@sugabots/contracts/errors/proofs";
import { TurnExecutionSuperseded } from "@sugabots/contracts/errors/turns";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { Effect } from "effect";
import { askerOf, turnFacts } from "../../authentication/turn-facts.ts";
import type { ProjectPermission } from "../../authorization/permissions.ts";
import { type Database, query } from "../../database/database.ts";
import { ACTIVE_TURN_STATUSES, placedChat, turn, workspace } from "../../database/schema.ts";
import type { Principal } from "../../principal.ts";
import { mayInProjectAs, memberReaches, reachFacts, turnReachesChat } from "../../proofs/facts.ts";
import type { RunsTurn } from "../../proofs/runs-turn.ts";

/**
 * The fence every write `RunsTurn` guards checks in its own SQL: the turn
 * hasn't ended, and the principal's execution of it is still the current
 * one. A workflow may resume a turn in another process while a slow one
 * still runs a step there; the authenticator raised the turn's execution
 * number when it resumed, so the slow one's writes no longer pass.
 */
export const fenced = (proof: FencedProof) =>
	and(
		eq(turn.id, proof.turn.value),
		inArray(turn.status, [...ACTIVE_TURN_STATUSES]),
		eq(turn.executionNumber, proof.execution),
	);

/**
 * A proof about one execution of a turn, whose writes the fence guards:
 * `RunsTurn`, or `EndsTurn` for the write that ends it. A tool's write may
 * also say what it needs of the turn's asker in a project (see
 * `holdTurnForToolWrite`).
 */
export type FencedProof = Pick<RunsTurn<unknown, unknown>, "execution"> & {
	readonly turn: { readonly value: string };
	readonly needs?: WriteNeeds | undefined;
};

/**
 * What a tool's write needs of the member its turn acts for, which its
 * operation proved before the write: the permission `permission` in the
 * project `project`.
 */
export interface WriteNeeds {
	readonly project: string;
	readonly permission: ProjectPermission;
}

/**
 * The fence for the writes of the execution `execution` of the turn
 * `turnId`, for a tool that writes on its turn's behalf once its call is
 * recorded, outside the running turn's records: what it keeps passes the same
 * check the loop's own writes do, and what it `needs`.
 */
export const executionFence = (
	turnId: string,
	execution: number,
	needs?: WriteNeeds,
): FencedProof => ({
	turn: { value: turnId },
	execution,
	needs,
});

/** How the fence refuses a write: the turn ended, or a newer execution has taken it over. */
export type FenceRefusal = TurnEnded | TurnExecutionSuperseded;

/**
 * How the fence refuses a tool's write (see `holdTurnForToolWrite`): as it
 * refuses any write, or because the member its turn acts for lost the chat
 * or project meanwhile, or the permission the write needs.
 */
export type ToolWriteRefusal = FenceRefusal | ResourceHidden | ActionForbidden;

/**
 * Why the fence refused a write for `runsTurn`: the turn ended, or a newer
 * execution has taken it over.
 */
export const fenceRefusal = (runsTurn: FencedProof) =>
	Effect.gen(function* (): Effect.fn.Return<FenceRefusal, never, Database> {
		const [found] = yield* query((db) =>
			db
				.select({ status: turn.status, executionNumber: turn.executionNumber })
				.from(turn)
				.where(eq(turn.id, runsTurn.turn.value))
				.limit(1),
		);
		const active = found && (ACTIVE_TURN_STATUSES as readonly string[]).includes(found.status);
		return active && found.executionNumber !== runsTurn.execution
			? new TurnExecutionSuperseded()
			: new TurnEnded();
	});

/**
 * Passes the fence for a write `runsTurn` guards, in the write's own
 * transaction: locks the turn's row until the transaction ends, for update
 * when the write changes the turn itself and for share otherwise, so ending
 * or resuming the turn waits for the write, and a write after either finds
 * the fence closed and writes nothing.
 */
export const holdRunningTurn = (runsTurn: FencedProof, lock: "update" | "share") =>
	Effect.gen(function* () {
		const [held] = yield* query((db) =>
			db.select({ id: turn.id }).from(turn).where(fenced(runsTurn)).limit(1).for(lock),
		);
		if (!held) return yield* Effect.fail(yield* fenceRefusal(runsTurn));
	});

/**
 * The fence every write a tool call makes on its turn's behalf passes, in the
 * write's own transaction: the loop's fence (see `holdRunningTurn`), shared,
 * and closed too once the turn was asked to end (see `TurnEndRequest`), so a
 * call already in flight stops writing as the request commits, while the
 * loop's own writes still record how the turn ended.
 *
 * It first shares the workspace's lock, which every change to who reaches
 * what takes, so a removal or demotion either commits before it, and is seen,
 * or waits for the write. Under it, the turn must still reach its chat and,
 * for a write that `needs` it, its member must still reach the project and
 * hold the permission there: a call proved before the change doesn't write
 * after it. A run that acts for no member has nothing of a member to lose.
 */
export const holdTurnForToolWrite = (proof: FencedProof) =>
	Effect.gen(function* () {
		yield* shareWorkspaceLockOf(proof);
		const [held] = yield* query((db) =>
			db
				.select({ id: turn.id })
				.from(turn)
				.where(and(fenced(proof), isNull(turn.endRequested)))
				.limit(1)
				.for("share"),
		);
		if (!held) return yield* Effect.fail(yield* fenceRefusal(proof));
		const standing = yield* query((db) =>
			Effect.gen(function* () {
				const facts = yield* turnFacts(db, proof.turn.value);
				if (!facts || !(yield* turnReachesChat(db, facts))) return "hidden" as const;
				const asker = askerOf(facts);
				if (!proof.needs || asker === undefined) return "allowed" as const;
				const place = yield* reachFacts(db, proof.needs.project, { member: asker });
				if (!place?.member || !memberReaches(place.member, place.project)) return "hidden" as const;
				return mayInProjectAs(place.member, place.project, proof.needs.permission)
					? ("allowed" as const)
					: ("forbidden" as const);
			}),
		);
		if (standing === "hidden") return yield* new ResourceHidden({ resource: "chat" });
		if (standing === "forbidden") return yield* new ActionForbidden({ proof: "ToolWrite" });
	});

/**
 * Takes the lock of the workspace the turn's chat is in `FOR SHARE`: before
 * the turn's own row, the order every change to who reaches what takes them in.
 */
const shareWorkspaceLockOf = (proof: FencedProof) =>
	query((db) =>
		db
			.select({ id: workspace.id })
			.from(workspace)
			.innerJoin(placedChat, eq(placedChat.workspaceId, workspace.id))
			.innerJoin(turn, eq(turn.chatId, placedChat.id))
			.where(eq(turn.id, proof.turn.value))
			.for("share", { of: workspace }),
	);

/**
 * Holds the fence for tool writes (see `holdTurnForToolWrite`) of the turn
 * `principal` acts in, when it is a bot in a turn, so a write an operation
 * makes for a bot's tool call passes it, with what the write `needs`. A member
 * signed in has no turn to fence.
 */
export const holdTurnOf = (principal: Principal, needs?: WriteNeeds) =>
	principal._tag === "BotForAsker" || principal._tag === "AutomationRun"
		? holdTurnForToolWrite(executionFence(principal.turn, principal.executionNumber, needs))
		: Effect.void;
