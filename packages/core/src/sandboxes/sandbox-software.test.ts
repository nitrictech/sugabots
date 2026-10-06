import { Effect, Exit } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CurrentActor } from "../authorization/current-actor.ts";
import {
	pod,
	podMember,
	sandboxPodPackage,
	user,
	workspace,
	workspaceMember,
} from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import { SandboxSoftware } from "./sandbox-software.ts";

/** A pod's software as people see and change it, against Postgres. */
describe.skipIf(!process.env.DATABASE_URL)("sandbox software, against Postgres", () => {
	let software: SandboxSoftware.Interface;
	let podId: string;
	let adminId: string;
	let memberId: string;

	beforeAll(async () => {
		software = await runOnPostgres(Effect.provide(SandboxSoftware.Service, SandboxSoftware.layer));
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Software ${suffix}`, slug: `software-${suffix}` })
				.returning(),
		);
		const people = await onDatabase((db) =>
			db
				.insert(user)
				.values([
					{ name: "Ada", email: `software-ada-${suffix}@example.com` },
					{ name: "Kim", email: `software-kim-${suffix}@example.com` },
				])
				.returning(),
		);
		const [admin, member] = people;
		if (!space || !admin || !member) throw new Error("fixture");
		adminId = admin.id;
		memberId = member.id;
		await onDatabase((db) =>
			db.insert(workspaceMember).values([
				{ workspaceId: space.id, userId: adminId, role: "admin" },
				{ workspaceId: space.id, userId: memberId, role: "member" },
			]),
		);
		const [shared] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId: space.id,
					ownerId: adminId,
					kind: "shared",
					name: "Builders",
					slug: `builders-${suffix}`,
					createdById: adminId,
				})
				.returning(),
		);
		if (!shared) throw new Error("fixture");
		podId = shared.id;
		await onDatabase((db) =>
			db.insert(podMember).values({ workspaceId: space.id, podId, userId: memberId }),
		);
		await onDatabase((db) =>
			db.insert(sandboxPodPackage).values(
				["ffmpeg", "jq"].map((name) => ({
					workspaceId: space.id,
					podId,
					name,
					channel: "stable" as const,
					nixpkgsRev: "0d9e9b832d03ac387417e16ce1febf73b2e631e1",
					addedById: adminId,
				})),
			),
		);
	});

	afterAll(closeDatabase);

	const as = <A, E>(userId: string, effect: Effect.Effect<A, E, CurrentActor.Service>) =>
		runOnPostgres(
			Effect.exit(
				effect.pipe(CurrentActor.provide(CurrentActor.AuthenticatedUserId.vouchedFor(userId))),
			),
		);

	it("shows anyone in the pod its software, and who allowed each package", async () => {
		const exit = await as(memberId, software.podSoftware(podId));

		if (!Exit.isSuccess(exit)) throw new Error(exit.toString());
		expect(exit.value.packages.map(({ name, addedByName }) => [name, addedByName])).toEqual([
			["ffmpeg", "Ada"],
			["jq", "Ada"],
		]);
	});

	it("lets only someone who manages the pod's sandbox remove a package", async () => {
		const refused = await as(
			memberId,
			software.removePackage({ podId, name: "jq", channel: "stable" }),
		);
		const removed = await as(
			adminId,
			software.removePackage({ podId, name: "jq", channel: "stable" }),
		);

		expect(Exit.isFailure(refused) && refused.toString()).toContain("ActionForbidden");
		if (!Exit.isSuccess(removed)) throw new Error(removed.toString());
		expect(removed.value.packages.map(({ name }) => name)).toEqual(["ffmpeg"]);
	});
});
