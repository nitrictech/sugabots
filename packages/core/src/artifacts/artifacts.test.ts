import { Effect } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
	agent,
	pod,
	podMember,
	thread,
	user,
	workspace,
	workspaceMember,
} from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import { servedOnPostgresAs } from "../workspaces/testing.ts";
import { Artifacts } from "./artifacts.ts";

describe.skipIf(!process.env.DATABASE_URL)("artifacts, against Postgres", () => {
	let by: Artifacts.AgentInThread;
	let memberId: string;
	let outsiderId: string;
	let otherPodAgent: Artifacts.AgentInPod;

	const authoring = async () => ({
		service: await runOnPostgres(Effect.provide(Artifacts.Authoring, Artifacts.authoringLayer)),
		/** Runs `effect`, which should fail, to its failure. */
		failureOf: <A, E>(effect: Effect.Effect<A, E>) => runOnPostgres(Effect.flip(effect)),
	});

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Artifacts ${stamp}`, slug: `artifacts-${stamp}` })
				.returning(),
		);
		const [member, outsider] = await onDatabase((db) =>
			db
				.insert(user)
				.values([
					{ name: "Kim", email: `kim-${stamp}@example.com` },
					{ name: "Ola", email: `ola-${stamp}@example.com` },
				])
				.returning(),
		);
		if (!space || !member || !outsider) throw new Error("fixture");
		const workspaceId = space.id;
		memberId = member.id;
		outsiderId = outsider.id;
		await onDatabase((db) =>
			db.insert(workspaceMember).values([
				{ workspaceId, userId: memberId, role: "member" },
				{ workspaceId, userId: outsiderId, role: "member" },
			]),
		);
		const [room, elsewhere] = await onDatabase((db) =>
			db
				.insert(pod)
				.values([
					{ workspaceId, kind: "shared", name: "Planning", slug: `planning-${stamp}` },
					{ workspaceId, kind: "shared", name: "Elsewhere", slug: `elsewhere-${stamp}` },
				])
				.returning(),
		);
		if (!room || !elsewhere) throw new Error("fixture");
		await onDatabase((db) =>
			db.insert(podMember).values({ workspaceId, podId: room.id, userId: memberId }),
		);
		const [writer, stranger] = await onDatabase((db) =>
			db
				.insert(agent)
				.values(
					[
						{ podId: room.id, name: "Scribe" },
						{ podId: elsewhere.id, name: "Stranger" },
					].map((made) => ({
						workspaceId,
						...made,
						handle: `${made.name.toLowerCase()}-${stamp}`,
						color: "green" as const,
						face: "pill" as const,
						model: "claude-opus-4-1-20250805",
						createdById: memberId,
					})),
				)
				.returning(),
		);
		if (!writer || !stranger) throw new Error("fixture");
		const [where] = await onDatabase((db) =>
			db
				.insert(thread)
				.values({
					workspaceId,
					podId: room.id,
					hostAgentId: writer.id,
					type: "collaboration",
					title: "Planning",
				})
				.returning(),
		);
		if (!where) throw new Error("fixture");
		by = { workspaceId, podId: room.id, agentId: writer.id, threadId: where.id };
		otherPodAgent = { workspaceId, podId: elsewhere.id, agentId: stranger.id };
	});

	it("keeps every version of a document an agent writes, for people in its pod to read", async () => {
		const { service } = await authoring();
		const made = await runOnPostgres(
			service.create(by, {
				kind: "document",
				title: "Launch plan",
				content: "# Launch plan\n\n## Goals\n\nShip.\n\n## Risks\n\nNone yet.\n",
			}),
		);
		await runOnPostgres(
			service.replaceSection(by, {
				artifactId: made.id,
				baseVersion: 1,
				heading: "goals",
				content: "## Goals\n\nShip by Friday.",
			}),
		);

		const reader = (await servedOnPostgresAs(Artifacts.Service, Artifacts.layer))(memberId);
		const at = { podId: by.podId, artifactId: made.id };
		expect(await reader.get(at)).toMatchObject({
			version: 2,
			createdBy: { name: "Scribe" },
			content: "# Launch plan\n\n## Goals\n\nShip by Friday.\n\n## Risks\n\nNone yet.\n",
		});
		expect((await reader.versions(at)).map((version) => version.number)).toEqual([2, 1]);
		expect(await reader.getVersion({ ...at, version: 1 })).toMatchObject({
			version: 2,
			shownVersion: { number: 1 },
			content: expect.stringContaining("Ship.\n"),
		});
	});

	it("refuses a change based on an older version, and keeps the newer one", async () => {
		const { service, failureOf } = await authoring();
		const made = await runOnPostgres(
			service.create(by, { kind: "html", title: "Chart", content: "<p>one</p>" }),
		);
		await runOnPostgres(
			service.replace(by, { artifactId: made.id, baseVersion: 1, content: "<p>two</p>" }),
		);

		const stale = await failureOf(
			service.replace(by, { artifactId: made.id, baseVersion: 1, content: "<p>lost</p>" }),
		);

		expect(stale).toMatchObject({ _tag: "ArtifactStale", currentVersion: 2 });
		expect(await runOnPostgres(service.read(by, made.id))).toMatchObject({
			version: 2,
			content: "<p>two</p>",
		});
	});

	it("hides a pod's artifacts from people outside it and from other pods' agents", async () => {
		const { service, failureOf } = await authoring();
		const made = await runOnPostgres(
			service.create(by, { kind: "document", title: "Private", content: "# Private" }),
		);

		const outsider = (await servedOnPostgresAs(Artifacts.Service, Artifacts.layer))(outsiderId);
		await expect(outsider.get({ podId: by.podId, artifactId: made.id })).rejects.toMatchObject({
			_tag: "ResourceHidden",
		});
		expect(await failureOf(service.read(otherPodAgent, made.id))).toMatchObject({
			_tag: "ArtifactNotFound",
		});
	});
});
