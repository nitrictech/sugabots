import { handleFromName } from "@sugabots/contracts";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import {
	agent,
	pod,
	podMember,
	thread,
	user,
	workspace,
	workspaceMember,
} from "@sugabots/core/database/schema";
import { closeDatabase, onDatabase, runOnPostgres } from "@sugabots/core/database/testing";
import { onPostgresAs } from "@sugabots/core/workspaces/testing";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { closedChannelAccess } from "./access.test-support.ts";
import { ChannelAccess } from "./access.ts";

/**
 * Who may listen to what. The workspace half is a membership query, so it needs
 * a migrated database and skips without one, as `db/schema.test.ts` does.
 */

/** The access with its answers run as `userId`, with nothing else to reach. */
function asSomebody(access: ChannelAccess.Interface, userId: string) {
	const asThem = CurrentActor.provide(CurrentActor.AuthenticatedUserId.vouchedFor(userId));
	return {
		workspace: (id: string) => Effect.runPromise(access.workspace(id).pipe(asThem)),
		thread: (id: string) => Effect.runPromise(access.thread(id).pipe(asThem)),
	};
}

it("denies event access when no access dependency is configured", async () => {
	const { workspace, thread } = asSomebody(closedChannelAccess, crypto.randomUUID());

	expect(await workspace("w1")).toBeUndefined();
	expect(await thread("c1")).toBeUndefined();
});

describe.skipIf(!process.env.DATABASE_URL)("database access", () => {
	afterAll(closeDatabase);

	/**
	 * A workspace with a member in a shared pod, an administrator who is not in
	 * it, and one person left outside the workspace.
	 */
	async function fixture() {
		const suffix = crypto.randomUUID();

		const [member] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Member", email: `member-${suffix}@example.com` })
				.returning(),
		);
		const [outsider] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Outsider", email: `outsider-${suffix}@example.com` })
				.returning(),
		);
		const [administrator] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Admin", email: `admin-${suffix}@example.com` })
				.returning(),
		);
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: "Test", slug: `test-${suffix}` })
				.returning(),
		);

		if (!member || !outsider || !administrator || !space) {
			throw new Error("fixture did not insert");
		}

		await onDatabase((db) =>
			db.insert(workspaceMember).values([
				{ workspaceId: space.id, userId: member.id },
				{ workspaceId: space.id, userId: administrator.id, role: "admin" },
			]),
		);

		// A pod the member is in, with a thread hosted by an agent placed there.
		const [room] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId: space.id,
					kind: "shared",
					name: "Room",
					slug: `room-${suffix}`,
					createdById: member.id,
				})
				.returning(),
		);
		const [host] = await onDatabase((db) =>
			db
				.insert(agent)
				.values({
					workspaceId: space.id,
					podId: room?.id ?? "",
					name: `Host ${suffix}`,
					handle: handleFromName(`Host ${suffix}`),
					color: "rose",
					face: "pill",
					model: "m",
				})
				.returning(),
		);
		if (!room || !host) {
			throw new Error("fixture did not insert");
		}
		await onDatabase((db) =>
			db.insert(podMember).values({ workspaceId: space.id, podId: room.id, userId: member.id }),
		);
		const [conversation] = await onDatabase((db) =>
			db
				.insert(thread)
				.values({
					workspaceId: space.id,
					podId: room.id,
					hostAgentId: host.id,
					type: "chat",
					title: "A thread",
					initiatorUserId: member.id,
				})
				.returning(),
		);
		if (!conversation) {
			throw new Error("fixture did not insert");
		}

		// The real services, over the real database, since that is what the
		// visibility joins are being checked against.
		const channels = await runOnPostgres(
			Effect.provide(ChannelAccess.Service, ChannelAccess.layer),
		);
		return {
			/** The channels `userId` is given. */
			access: (userId: string) => onPostgresAs(userId)(channels),
			member,
			administrator,
			outsider,
			space,
			conversation,
		};
	}

	it("gives a member the workspace channel", async () => {
		const { access, member, space } = await fixture();

		expect(await access(member.id).workspace(space.id)).toBe(`workspace:${space.id}`);
	});

	it("gives a member the same channel when the workspace is named by its slug", async () => {
		const { access, member, space } = await fixture();

		expect(await access(member.id).workspace(space.slug)).toBe(`workspace:${space.id}`);
	});

	it("gives someone who is not a member nothing", async () => {
		const { access, outsider, space } = await fixture();

		expect(await access(outsider.id).workspace(space.id)).toBeUndefined();
		expect(await access(outsider.id).workspace(space.slug)).toBeUndefined();
	});

	it("gives nothing for a workspace that does not exist", async () => {
		const { access, member } = await fixture();

		expect(await access(member.id).workspace(crypto.randomUUID())).toBeUndefined();
	});

	it("gives nothing for a slug that names no workspace, rather than raising on it", async () => {
		const { access, member } = await fixture();

		expect(await access(member.id).workspace("not-a-uuid")).toBeUndefined();
	});

	it("gives a pod member the thread's channel", async () => {
		const { access, member, conversation } = await fixture();

		expect(await access(member.id).thread(conversation.id)).toBe(`thread:${conversation.id}`);
	});

	it("gives someone outside the pod nothing for its thread", async () => {
		const { access, outsider, conversation } = await fixture();

		expect(await access(outsider.id).thread(conversation.id)).toBeUndefined();
	});

	it("gives nothing for a thread that does not exist", async () => {
		const { access, member } = await fixture();

		expect(await access(member.id).thread(crypto.randomUUID())).toBeUndefined();
	});

	it("gives an administrator the channel of a shared pod's thread without membership", async () => {
		const { access, administrator, conversation } = await fixture();

		expect(await access(administrator.id).thread(conversation.id)).toBe(
			`thread:${conversation.id}`,
		);
	});

	it("lets only people who reach a pod hear the workspace's events about it", async () => {
		const { access, member, administrator, space, conversation } = await fixture();
		const [elsewhere] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Elsewhere", email: `elsewhere-${crypto.randomUUID()}@example.com` })
				.returning(),
		);
		if (!elsewhere) throw new Error("fixture did not insert");
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId: space.id, userId: elsewhere.id }),
		);

		expect(await access(member.id).reachesPod(conversation.podId)).toBe(true);
		expect(await access(administrator.id).reachesPod(conversation.podId)).toBe(true);
		expect(await access(elsewhere.id).workspace(space.id)).toBe(`workspace:${space.id}`);
		expect(await access(elsewhere.id).reachesPod(conversation.podId)).toBe(false);
	});

	it("takes the channel away once the administrator is demoted", async () => {
		const { access, administrator, space, conversation } = await fixture();
		await onDatabase((db) =>
			db
				.update(workspaceMember)
				.set({ role: "member" })
				.where(
					and(
						eq(workspaceMember.workspaceId, space.id),
						eq(workspaceMember.userId, administrator.id),
					),
				),
		);

		expect(await access(administrator.id).thread(conversation.id)).toBeUndefined();
	});
});
