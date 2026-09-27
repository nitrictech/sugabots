import type { NewConnection } from "@sugabots/contracts";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Credentials } from "../../credentials/credentials.ts";
import { pod, user, workspace, workspaceMember } from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	type Promised,
	runOnPostgres,
	servedOnPostgres,
} from "../../database/testing.ts";
import { connectionIn } from "./connection-reads.ts";
import { ConnectionRepository } from "./connection-repository.ts";

describe.skipIf(!process.env.DATABASE_URL)("connections, against Postgres", () => {
	let connections: Promised<ConnectionRepository.Interface>;
	let workspaceId: string;
	let userId: string;
	let podId: string;
	let otherPodId: string;

	beforeAll(async () => {
		connections = await servedOnPostgres(ConnectionRepository.Service, ConnectionRepository.layer);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	const create = (input: NewConnection) => connections.create(workspaceId, podId, userId, input);
	/** The connection as the settings page is shown it, through `inPod`. */
	const shown = (connectionId: string, inPod = podId) =>
		runOnPostgres(
			Effect.flatMap(Credentials.Service, (cipher) =>
				connectionIn(workspaceId, inPod, connectionId, cipher),
			),
		);

	beforeEach(async () => {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Connections ${suffix}`, slug: `connections-${suffix}` })
				.returning(),
		);
		const [person] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Sam", email: `connections-${suffix}@example.com` })
				.returning(),
		);
		if (!space || !person) throw new Error("fixture");
		workspaceId = space.id;
		userId = person.id;
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId, userId, role: "admin" }),
		);
		const [room, otherRoom] = await onDatabase((db) =>
			db
				.insert(pod)
				.values([
					{
						workspaceId,
						ownerId: userId,
						kind: "shared",
						name: "Support",
						slug: `support-${suffix}`,
						createdById: userId,
					},
					{
						workspaceId,
						ownerId: userId,
						kind: "shared",
						name: "Sales",
						slug: `sales-${suffix}`,
						createdById: userId,
					},
				])
				.returning(),
		);
		if (!room || !otherRoom) throw new Error("pod fixture");
		podId = room.id;
		otherPodId = otherRoom.id;
	});

	it("refuses a second connection with the same name", async () => {
		await create({
			name: "Team Wiki",
			url: "https://wiki.example.com/mcp",
		});

		await expect(
			create({
				name: "team wiki",
				url: "https://other.example/mcp",
			}),
		).rejects.toThrow(ConnectionRepository.ConnectionNameTaken);
	});

	it("hands a turn every connection that is not off, with what it may do", async () => {
		const wiki = await create({
			name: "Wiki",
			url: "https://wiki.example.com/mcp",
		});
		const off = await create({
			name: "Off",
			url: "https://off.example.com/mcp",
		});
		await connections.update(workspaceId, podId, wiki.id, { access: "ask" });
		await connections.update(workspaceId, podId, off.id, { access: "off" });

		const targets = await connections.targetsForPod(workspaceId, podId);

		expect(targets).toEqual([
			expect.objectContaining({ connectionId: wiki.id, handle: "wiki", access: "ask" }),
		]);
	});

	it("keeps a connection that signs in off until it has", async () => {
		const pasted = await create({
			name: "Wiki",
			url: "https://wiki.example.com/mcp",
		});
		const signsIn = await create({
			name: "Linear",
			url: "https://mcp.linear.app/mcp",
			auth: "oauth",
		});

		expect(pasted.access).toBe("allow");
		expect(signsIn.access).toBe("off");
	});

	it("does not expose a connection through another pod", async () => {
		const made = await create({
			name: "Wiki",
			url: "https://wiki.example.com/mcp",
		});

		expect(await shown(made.id, otherPodId)).toBeUndefined();
		expect(await connections.target(workspaceId, otherPodId, made.id)).toBeUndefined();
		expect(
			await connections.update(workspaceId, otherPodId, made.id, { access: "ask" }),
		).toBeUndefined();
		expect(await connections.remove(workspaceId, otherPodId, made.id)).toBe(false);
		expect((await shown(made.id))?.id).toEqual(made.id);
	});

	it("keeps an OAuth connection's sealed record, and finds it again by the state of a sign-in", async () => {
		const made = await create({
			name: "Linear",
			url: "https://mcp.linear.app/mcp",
			auth: "oauth",
			secret: "ignored",
		});
		expect(await shown(made.id)).toMatchObject({
			auth: "oauth",
			signedIn: false,
			hasSecret: false,
		});
		expect(await connections.target(workspaceId, podId, made.id)).toMatchObject({
			auth: "oauth",
			headers: {},
		});

		await connections.saveOauthRecord(workspaceId, made.id, {
			clientInformation: { client_id: "client-1" },
			codeVerifier: "verifier",
			state: "state-1",
		});
		expect(await connections.byOauthState("state-1")).toEqual({
			workspaceId,
			podId,
			connectionId: made.id,
		});
		expect((await shown(made.id))?.signedIn).toBe(false);

		await connections.saveOauthRecord(workspaceId, made.id, {
			clientInformation: { client_id: "client-1" },
			tokens: { access_token: "token-1", token_type: "Bearer" },
			state: "",
		});
		expect(await connections.oauthRecord(workspaceId, made.id)).toMatchObject({
			tokens: { access_token: "token-1" },
		});
		expect(await connections.byOauthState("state-1")).toBeUndefined();
		expect((await shown(made.id))?.signedIn).toBe(true);
	});

	it("hands the caller the URL and the secret as a header", async () => {
		const made = await create({
			name: "Wiki",
			url: "https://wiki.example.com/mcp",
			secretHeader: "authorization",
			secret: "Bearer abc",
		});

		expect(await connections.target(workspaceId, podId, made.id)).toMatchObject({
			connectionId: made.id,
			handle: "wiki",
			url: "https://wiki.example.com/mcp",
			headers: { authorization: "Bearer abc" },
		});

		const open = await create({
			name: "Open",
			url: "https://open.example.com/mcp",
		});
		expect(await connections.target(workspaceId, podId, open.id)).toMatchObject({ headers: {} });
	});

	it("records what a test found, and forgets it when the connection changes", async () => {
		const made = await create({
			name: "Wiki",
			url: "https://wiki.example.com/mcp",
		});
		const target = await connections.target(workspaceId, podId, made.id);
		if (!target) throw new Error("no target");
		expect(target.configurationRevision).toBe(1);

		await connections.recordTest(workspaceId, made.id, target.configurationUpdatedAt, {
			tools: [
				{ name: "web_search_exa", description: "Search.", readOnly: true, destructive: null },
			],
		});
		expect(await shown(made.id)).toMatchObject({
			status: "connected",
			tools: [{ name: "web_search_exa" }],
		});
		expect((await connections.target(workspaceId, podId, made.id))?.configurationRevision).toBe(1);

		await connections.update(workspaceId, podId, made.id, { secret: "exa-key" });
		expect((await connections.target(workspaceId, podId, made.id))?.configurationRevision).toBe(2);
		expect(await shown(made.id)).toMatchObject({
			status: "untested",
			hasSecret: true,
			// The tools stay: they are what the server offers, not what a key unlocks.
			tools: [{ name: "web_search_exa" }],
		});
	});
});
