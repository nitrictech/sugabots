import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pod, user, workspace, workspaceMember } from "../../database/schema.ts";
import { closeDatabase, onDatabase, onPostgres, type Promised } from "../../database/testing.ts";
import { aesCredentialCipher } from "../model-providers/credentials.ts";
import { ConnectionNameTaken, type ConnectionStore, connectionStore } from "./store.ts";

describe.skipIf(!process.env.DATABASE_URL)("connections, against Postgres", () => {
	const cipher = aesCredentialCipher(Buffer.alloc(32, 9).toString("base64"));
	const connections: Promised<ConnectionStore> = onPostgres(connectionStore(cipher));
	let workspaceId: string;
	let userId: string;
	let podId: string;
	let otherPodId: string;

	afterAll(async () => {
		await closeDatabase();
	});

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
		await connections.create(workspaceId, podId, userId, {
			name: "Team Wiki",
			url: "https://wiki.example.com/mcp",
		});

		await expect(
			connections.create(workspaceId, podId, userId, {
				name: "team wiki",
				url: "https://other.example/mcp",
			}),
		).rejects.toThrow(ConnectionNameTaken);
	});

	it("hands a turn only the enabled connections among those it names", async () => {
		const wiki = await connections.create(workspaceId, podId, userId, {
			name: "Wiki",
			url: "https://wiki.example.com/mcp",
		});
		await connections.create(workspaceId, podId, userId, {
			name: "Off",
			url: "https://off.example.com/mcp",
		});
		await connections.update(workspaceId, podId, wiki.id, {
			enabled: true,
			allowMutating: true,
		});

		const targets = await connections.targetsForPod(workspaceId, podId);

		expect(targets).toEqual([
			expect.objectContaining({ connectionId: wiki.id, handle: "wiki", allowMutating: true }),
		]);
	});

	it("does not expose a connection through another pod", async () => {
		const made = await connections.create(workspaceId, podId, userId, {
			name: "Wiki",
			url: "https://wiki.example.com/mcp",
		});

		expect(await connections.get(workspaceId, otherPodId, made.id)).toBeUndefined();
		expect(await connections.target(workspaceId, otherPodId, made.id)).toBeUndefined();
		expect(
			await connections.update(workspaceId, otherPodId, made.id, { enabled: true }),
		).toBeUndefined();
		expect(await connections.remove(workspaceId, otherPodId, made.id)).toBe(false);
		expect(await connections.get(workspaceId, podId, made.id)).toEqual(made);
	});

	it("keeps an OAuth connection's sealed record, and finds it again by the state of a sign-in", async () => {
		const made = await connections.create(workspaceId, podId, userId, {
			name: "Linear",
			url: "https://mcp.linear.app/mcp",
			auth: "oauth",
			secret: "ignored",
		});
		expect(made).toMatchObject({ auth: "oauth", signedIn: false, hasSecret: false });
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
		expect((await connections.get(workspaceId, podId, made.id))?.signedIn).toBe(false);

		await connections.saveOauthRecord(workspaceId, made.id, {
			clientInformation: { client_id: "client-1" },
			tokens: { access_token: "token-1", token_type: "Bearer" },
			state: "",
		});
		expect(await connections.oauthRecord(workspaceId, made.id)).toMatchObject({
			tokens: { access_token: "token-1" },
		});
		expect(await connections.byOauthState("state-1")).toBeUndefined();
		expect((await connections.get(workspaceId, podId, made.id))?.signedIn).toBe(true);
	});

	it("hands the caller the URL and the secret as a header", async () => {
		const made = await connections.create(workspaceId, podId, userId, {
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

		const open = await connections.create(workspaceId, podId, userId, {
			name: "Open",
			url: "https://open.example.com/mcp",
		});
		expect(await connections.target(workspaceId, podId, open.id)).toMatchObject({ headers: {} });
	});

	it("records what a test found, and forgets it when the connection changes", async () => {
		const made = await connections.create(workspaceId, podId, userId, {
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
		expect(await connections.get(workspaceId, podId, made.id)).toMatchObject({
			status: "connected",
			tools: [{ name: "web_search_exa" }],
		});
		expect((await connections.target(workspaceId, podId, made.id))?.configurationRevision).toBe(1);

		await connections.update(workspaceId, podId, made.id, { secret: "exa-key" });
		expect((await connections.target(workspaceId, podId, made.id))?.configurationRevision).toBe(2);
		expect(await connections.get(workspaceId, podId, made.id)).toMatchObject({
			status: "untested",
			hasSecret: true,
			// The tools stay: they are what the server offers, not what a key unlocks.
			tools: [{ name: "web_search_exa" }],
		});
	});
});
