import {
	DEFAULT_POD_COLOR,
	leastUsedPodColor,
	PERSONAL_POD_SLUG,
	type Pod,
	type PodColor,
	type PodMember,
	type PodPermissions,
	type PodUpdate,
} from "@sugabots/contracts";
import { and, asc, eq, sql } from "drizzle-orm";
import { Data, Effect } from "effect";
import {
	type Database,
	type Executor,
	query,
	queryCatching,
	transaction,
} from "../../database/database.ts";
import { isUniqueViolation } from "../../database/errors.ts";
import type * as schema from "../../database/schema.ts";
import { agent, pod, podMember, user, workspaceMember } from "../../database/schema.ts";
import { type PodStanding, podStanding, reachesPod } from "../access.ts";
import { facilitatorIsSetUp } from "../agents/system-agent-store.ts";
import { type Actor, podPermissions } from "../permissions.ts";

/**
 * The model a Personal Assistant is given when its pod is provisioned without
 * one, which is the invitation path: somebody joining has no model to name yet.
 */
const FALLBACK_ASSISTANT_MODEL = "claude-sonnet-4-20250514";

export const PERSONAL_ASSISTANT_PROMPT =
	"You are Personal Assistant, the user's general-purpose assistant. Help them answer questions, think through problems, make plans, write, and complete tasks. Be clear, practical, and concise. Ask clarifying questions when important details are missing. Distinguish facts from assumptions and say when you are uncertain. Use available tools when they help, and report their results accurately.";

/**
 * Reading and writing pods.
 *
 * Separate from `Authorization` on purpose: this answers "what is there",
 * `Authorization` answers "may you have it". Keeping them apart is what lets
 * the routes be tested with a fake store and a real policy, or the other way
 * round.
 *
 * The one place the two meet is the reach of a list. `listVisible` scopes its
 * query with `reachesPod`, the same rule `Authorization` applies to a single
 * pod, so what a list shows and what a direct read allows cannot drift apart.
 *
 * An interface for the same reason the event bus is one — the HTTP tests run
 * without Postgres.
 */

export interface PodStore {
	/** The pods this person reaches in a workspace, by name. */
	listVisible(workspaceId: string, actor: Actor): Effect.Effect<Pod[], never, Database>;
	/**
	 * Creates the pod, puts its creator in it, and places the system agents.
	 * The slug is derived and validated by the route, so it is required here.
	 * Without a colour it takes the one fewest of the workspace's pods have.
	 */
	create(
		workspaceId: string,
		creator: Actor,
		input: { name: string; slug: string; color?: PodColor },
	): Effect.Effect<Pod, SlugTaken, Database>;
	/** Idempotently provisions the private pod and assistant for one member. */
	ensurePersonal(
		workspaceId: string,
		owner: Actor,
		model: string,
	): Effect.Effect<Pod, never, Database>;
	/** The stored row; the route shapes it for whoever asked. */
	update(
		workspaceId: string,
		podId: string,
		input: PodUpdate,
	): Effect.Effect<
		schema.PodRow,
		PersonalPodFixed | PodGone | SlugTaken | FacilitatorNotSetUp,
		Database
	>;
	remove(workspaceId: string, podId: string): Effect.Effect<void, PersonalPodFixed, Database>;
	listMembers(podId: string): Effect.Effect<PodMember[], never, Database>;
	/** Adds a workspace member atomically; repeated adds are harmless. */
	addMember(
		workspaceId: string,
		podId: string,
		userId: string,
	): Effect.Effect<
		"added" | "already_member" | "not_workspace_member" | "personal_pod",
		never,
		Database
	>;
	/** Refuses an administrator, who belongs to every shared pod. */
	removeMember(
		workspaceId: string,
		podId: string,
		userId: string,
	): Effect.Effect<"removed" | "not_a_member" | "personal_pod" | "administrator", never, Database>;
}

/** The slug is taken in this workspace. The route makes it a `conflict`. */
export class SlugTaken extends Data.TaggedError("SlugTaken")<{ readonly slug: string }> {
	override get message() {
		return `A pod with the slug "${this.slug}" already exists in this workspace`;
	}
}

/** A write names a pod that is no longer there. `not_found`. */
export class PodGone extends Data.TaggedError("PodGone")<{ readonly podId: string }> {
	override get message() {
		return `No pod with the id "${this.podId}"`;
	}
}

/**
 * A Personal pod is one person's: it keeps the name it was given and it stays
 * for as long as they are in the workspace.
 *
 * Raised here rather than checked by each caller, so the rule holds however a
 * pod is reached. Its owner holds every *permission* in it — this is the
 * domain refusing an impossible request, which is why the route makes it a
 * `bad_request` and not a `forbidden`.
 */
export class PersonalPodFixed extends Data.TaggedError("PersonalPodFixed")<{
	readonly attempted: "rename" | "delete";
}> {
	override get message() {
		return this.attempted === "rename"
			? "A Personal pod's name, address and colour cannot be changed"
			: "Personal pods cannot be deleted";
	}
}

/**
 * A pod asked to route through the Facilitator before the workspace chose a
 * model for it. Refused for the same reason and in the same way as the rule
 * above: an impossible request rather than a permission refusal, so the route
 * makes it a `bad_request`.
 */
export class FacilitatorNotSetUp extends Data.TaggedError("FacilitatorNotSetUp") {
	override get message() {
		return "Choose a model for the Facilitator before a pod can route through it";
	}
}

const create: PodStore["create"] = (workspaceId, creator, { name, slug, color }) =>
	// The insert and its members are one unit, so a pod is never briefly one
	// without the other: whoever made it, and every administrator, is in it.
	transaction(
		Effect.gen(function* () {
			const taken = yield* query((db) =>
				db
					.select({ color: pod.color })
					.from(pod)
					.where(and(eq(pod.workspaceId, workspaceId), eq(pod.kind, "shared"))),
			);
			const [row] = yield* query((db) =>
				db
					.insert(pod)
					.values({
						workspaceId,
						kind: "shared",
						name,
						slug,
						color: color ?? leastUsedPodColor(taken.map((one) => podColorOf(one.color))),
						createdById: creator.userId,
					})
					.onConflictDoNothing({
						target: [pod.workspaceId, pod.slug],
						where: sql`${pod.kind} = 'shared'`,
					})
					.returning(),
			);

			if (!row) {
				return yield* new SlugTaken({ slug });
			}

			// The `shared_pod_administrators` trigger has already added every
			// administrator, the creator too if they are one.
			yield* query((db) =>
				db
					.insert(podMember)
					.values({ workspaceId, podId: row.id, userId: creator.userId })
					.onConflictDoNothing({ target: [podMember.podId, podMember.userId] }),
			);
			return podSeenBy(podStanding(row, creator, true));
		}),
	);

const ensurePersonal: PodStore["ensurePersonal"] = (workspaceId, owner, model) =>
	transaction(
		query((db) =>
			Effect.map(provisionPersonalPod(db, workspaceId, owner.userId, model), (personal) =>
				podSeenBy(podStanding(personal, owner, true)),
			),
		),
	);

export const provisionPersonalPod = Effect.fn("PodStore.provisionPersonalPod")(function* (
	db: Executor,
	workspaceId: string,
	userId: string,
	model?: string,
) {
	const [created] = yield* db
		.insert(pod)
		.values({
			workspaceId,
			ownerId: userId,
			kind: "personal",
			name: "Personal",
			slug: PERSONAL_POD_SLUG,
			createdById: userId,
		})
		.onConflictDoNothing()
		.returning();
	const personal =
		created ??
		(yield* db
			.select()
			.from(pod)
			.where(
				and(eq(pod.workspaceId, workspaceId), eq(pod.ownerId, userId), eq(pod.kind, "personal")),
			)
			.limit(1))[0];
	if (!personal) {
		throw new Error("Personal pod could not be provisioned");
	}

	yield* db
		.insert(podMember)
		.values({ workspaceId, podId: personal.id, userId })
		.onConflictDoNothing({ target: [podMember.podId, podMember.userId] });
	const [createdAssistant] = yield* db
		.insert(agent)
		.values({
			workspaceId,
			podId: personal.id,
			createdById: userId,
			name: "Personal Assistant",
			handle: "personal-assistant",
			provisionedKey: "personal-assistant",
			description: "Your private assistant.",
			color: "sky",
			face: "pill",
			model: model ?? FALLBACK_ASSISTANT_MODEL,
			prompt: PERSONAL_ASSISTANT_PROMPT,
		})
		.onConflictDoNothing({ target: [agent.podId, agent.provisionedKey] })
		.returning({ id: agent.id });
	if (!createdAssistant && model !== undefined) {
		yield* db
			.update(agent)
			.set({ model })
			.where(and(eq(agent.podId, personal.id), eq(agent.provisionedKey, "personal-assistant")));
	}
	return personal;
});

const update: PodStore["update"] = (workspaceId, podId, input) =>
	Effect.gen(function* () {
		// The Facilitator runs on a model the workspace chooses once, so a pod
		// cannot hand it the floor before anybody has chosen one. Refused here
		// rather than in the route, so it holds however the pod is reached.
		if (input.routing?.facilitator === true && !(yield* facilitatorIsSetUp(workspaceId))) {
			return yield* new FacilitatorNotSetUp();
		}

		if (input.name !== undefined || input.slug !== undefined || input.color !== undefined) {
			const [target] = yield* query((db) =>
				db
					.select({ kind: pod.kind })
					.from(pod)
					.where(and(eq(pod.id, podId), eq(pod.workspaceId, workspaceId)))
					.limit(1),
			);
			if (target?.kind === "personal") {
				return yield* new PersonalPodFixed({ attempted: "rename" });
			}
		}

		// An UPDATE has no `on conflict`, so a taken slug arrives as a Postgres
		// unique violation. Naming it here is what keeps it a 409 rather than
		// a 500; anything else the driver says is still a bug.
		const [row] = yield* queryCatching(
			(db) =>
				db
					.update(pod)
					.set(input)
					.where(and(eq(pod.id, podId), eq(pod.workspaceId, workspaceId)))
					.returning(),
			(failure) =>
				isUniqueViolation(failure) ? new SlugTaken({ slug: input.slug ?? "" }) : undefined,
		);

		// Authorisation already found this pod, so no row means it was deleted in
		// between — not that anything conflicted.
		if (!row) {
			return yield* new PodGone({ podId });
		}
		return row;
	});

const remove: PodStore["remove"] = (workspaceId, podId) =>
	Effect.gen(function* () {
		const [deleted] = yield* query((db) =>
			db
				.delete(pod)
				.where(and(eq(pod.id, podId), eq(pod.workspaceId, workspaceId), eq(pod.kind, "shared")))
				.returning({ id: pod.id }),
		);
		if (deleted) return;

		// Nothing went: either the pod is Personal, which is refused, or it was
		// already gone, which is the outcome the caller asked for.
		const [target] = yield* query((db) =>
			db
				.select({ kind: pod.kind })
				.from(pod)
				.where(and(eq(pod.id, podId), eq(pod.workspaceId, workspaceId)))
				.limit(1),
		);
		if (target?.kind === "personal") {
			return yield* new PersonalPodFixed({ attempted: "delete" });
		}
	});

export const podStore: PodStore = {
	listVisible: (workspaceId, actor) =>
		query((db) =>
			db
				.select({
					pod,
					isMember: sql<boolean>`${podMember.id} is not null`,
				})
				.from(pod)
				.leftJoin(podMember, and(eq(podMember.podId, pod.id), eq(podMember.userId, actor.userId)))
				.where(and(eq(pod.workspaceId, workspaceId), reachesPod(pod.id, actor.userId)))
				.orderBy(asc(pod.name)),
		).pipe(
			Effect.map((rows) => rows.map((row) => podSeenBy(podStanding(row.pod, actor, row.isMember)))),
		),

	create,
	ensurePersonal,
	update,
	remove,

	listMembers: (podId) =>
		query((db) =>
			db
				.select({
					userId: user.id,
					name: user.name,
					email: user.email,
					image: user.image,
					addedAt: podMember.createdAt,
					removable: sql<boolean>`${pod.kind} = 'shared' and ${workspaceMember.role} <> 'admin'`,
				})
				.from(podMember)
				.innerJoin(user, eq(user.id, podMember.userId))
				.innerJoin(pod, eq(pod.id, podMember.podId))
				.innerJoin(
					workspaceMember,
					and(
						eq(workspaceMember.workspaceId, podMember.workspaceId),
						eq(workspaceMember.userId, podMember.userId),
					),
				)
				.where(eq(podMember.podId, podId))
				.orderBy(asc(user.name)),
		).pipe(
			Effect.map((rows) => rows.map((row) => ({ ...row, addedAt: row.addedAt.toISOString() }))),
		),

	addMember: (workspaceId, podId, userId) =>
		Effect.gen(function* () {
			const [target] = yield* query((db) =>
				db
					.select({ kind: pod.kind })
					.from(pod)
					.where(and(eq(pod.id, podId), eq(pod.workspaceId, workspaceId)))
					.limit(1),
			);
			if (target?.kind === "personal") {
				return "personal_pod";
			}

			const inserted = yield* query((db) =>
				db.execute<{ id: string }>(
					sql`
					insert into ${podMember} ("workspace_id", "pod_id", "user_id")
					select ${pod.workspaceId}, ${pod.id}, ${userId}
					from ${pod}
					inner join ${workspaceMember}
						on ${workspaceMember.workspaceId} = ${pod.workspaceId}
						and ${workspaceMember.userId} = ${userId}
					where ${pod.id} = ${podId}
					and ${pod.workspaceId} = ${workspaceId}
					on conflict ("pod_id", "user_id") do nothing
					returning "id"
				`,
					"objects",
				),
			);

			if (inserted.length > 0) {
				return "added";
			}

			const [existing] = yield* query((db) =>
				db
					.select({ id: podMember.id })
					.from(podMember)
					.innerJoin(pod, eq(pod.id, podMember.podId))
					.innerJoin(
						workspaceMember,
						and(
							eq(workspaceMember.workspaceId, pod.workspaceId),
							eq(workspaceMember.userId, userId),
						),
					)
					.where(and(eq(podMember.podId, podId), eq(podMember.userId, userId)))
					.limit(1),
			);

			return existing ? "already_member" : "not_workspace_member";
		}),

	removeMember: (workspaceId, podId, userId) =>
		transaction(
			query((db) =>
				Effect.gen(function* () {
					// Held until the transaction ends, so nobody is promoted between the
					// role check and the delete. The pod and role triggers take it too.
					yield* db.execute(sql`select lock_pod_membership(${workspaceId})`);
					const [target] = yield* db
						.select({ kind: pod.kind })
						.from(pod)
						.where(and(eq(pod.id, podId), eq(pod.workspaceId, workspaceId)))
						.limit(1);
					if (target?.kind === "personal") {
						return "personal_pod";
					}
					const [membership] = yield* db
						.select({ role: workspaceMember.role })
						.from(workspaceMember)
						.where(
							and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, userId)),
						)
						.limit(1);
					if (membership?.role === "admin") {
						return "administrator";
					}
					const removed = yield* db
						.delete(podMember)
						.where(
							and(
								eq(podMember.workspaceId, workspaceId),
								eq(podMember.podId, podId),
								eq(podMember.userId, userId),
							),
						)
						.returning({ id: podMember.id });

					return removed.length > 0 ? "removed" : "not_a_member";
				}),
			),
		),
};

/** The row as the API returns it: timestamps as ISO strings, no internals. */
export function toPod(row: schema.PodRow, permissions: PodPermissions): Pod {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		ownerId: row.ownerId,
		kind: row.kind,
		name: row.name,
		slug: row.slug,
		color: row.kind === "shared" ? podColorOf(row.color) : null,
		routing: row.routing,
		permissions,
		createdAt: row.createdAt.toISOString(),
	};
}

/**
 * The pod as one person sees it, permissions and all.
 *
 * Takes a standing rather than a pod and a person, so the permissions on a pod
 * are always the ones the caller who asked for it holds.
 */
export function podSeenBy({ pod: row, actor, facts }: PodStanding): Pod {
	return toPod(row, podPermissions(actor, facts));
}

/** A shared pod's stored colour, or the default when it has none. */
function podColorOf(stored: PodColor | null): PodColor {
	return stored ?? DEFAULT_POD_COLOR;
}
