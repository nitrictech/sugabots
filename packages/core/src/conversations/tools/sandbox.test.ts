import type { ToolSet } from "ai";
import { Effect, Exit, Layer, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	pod,
	sandboxAllowedHost,
	user,
	workspace,
	workspaceMember,
} from "../../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../../database/testing.ts";
import { PodSandboxes } from "../../sandboxes/pod-sandboxes.ts";
import { SandboxProviderRepository } from "../../sandboxes/sandbox-provider-repository.ts";
import { Sandboxes } from "../../sandboxes/sandboxes.ts";
import { SandboxTools } from "./sandbox.ts";

/**
 * Where the sandbox tools work, against Postgres and a real OpenSandbox
 * server (`docker compose --profile sandboxes up -d`, with OPENSANDBOX_URL and
 * OPENSANDBOX_API_KEY set): each thread in its own folder, each agent in its
 * own home, both kept between turns.
 */
const env = process.env;
const configured = env.DATABASE_URL && env.OPENSANDBOX_URL && env.OPENSANDBOX_API_KEY;
const SLOW = 180_000;

describe.skipIf(!configured)("sandbox tools, against Postgres and OpenSandbox", () => {
	let sandboxTools: SandboxTools.Interface;
	let podSandboxes: PodSandboxes.Interface;
	let thePod: PodSandboxes.Pod;
	const scope = Effect.runSync(Scope.make());

	beforeAll(async () => {
		[sandboxTools, podSandboxes] = await runOnPostgres(
			Effect.all([SandboxTools.Service, PodSandboxes.Service]).pipe(
				Effect.provide(Layer.merge(SandboxTools.layer, PodSandboxes.layer)),
			),
		);
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Tools ${suffix}`, slug: `tools-${suffix}` })
				.returning(),
		);
		const [owner] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Sam", email: `tools-${suffix}@example.com` })
				.returning(),
		);
		if (!space || !owner) throw new Error("fixture");
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId: space.id, userId: owner.id }),
		);
		const [shared] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId: space.id,
					ownerId: owner.id,
					kind: "shared",
					name: "Builders",
					slug: `builders-${suffix}`,
					createdById: owner.id,
				})
				.returning(),
		);
		if (!shared) throw new Error("fixture");
		thePod = { workspaceId: space.id, podId: shared.id };
		const providers = await runOnPostgres(
			Effect.provide(SandboxProviderRepository.Service, SandboxProviderRepository.layer),
		);
		await runOnPostgres(
			providers.create(space.id, {
				createdById: owner.id,
				provider: {
					preset: "opensandbox",
					enabled: true,
					baseUrl: env.OPENSANDBOX_URL,
					apiKey: env.OPENSANDBOX_API_KEY,
					// The default image, which has curl: `bun run build:sandbox` first.
					image: "ghcr.io/nitrictech/sugabots-sandbox:latest",
				},
			}),
		);
	});

	afterAll(async () => {
		await Effect.runPromise(Scope.close(scope, Exit.void));
		const providers = await runOnPostgres(
			Effect.provide(SandboxProviderRepository.Service, SandboxProviderRepository.layer),
		);
		const provider = await runOnPostgres(providers.enabled(thePod.workspaceId));
		if (provider) await runOnPostgres(podSandboxes.destroyAllMadeBy(thePod.workspaceId, provider));
		await closeDatabase();
	}, SLOW);

	const toolsFor = (turnId: string, threadId: string, agentId: string) =>
		runOnPostgres(
			Scope.provide(scope)(
				sandboxTools.forTurn({ pod: thePod, usesSandbox: true, turnId, threadId, agentId }),
			),
		).then((offered) => offered.tools);

	const call = async (tools: ToolSet, name: string, input: object) => {
		const execute = tools[name]?.execute;
		if (!execute) throw new Error(`no ${name} tool`);
		// The SDK types each tool's input; these calls give each tool its own shape.
		const untyped = execute as (input: object, options: object) => Promise<unknown>;
		return (await untyped(input, { toolCallId: name, messages: [] })) as Record<string, unknown>;
	};

	const run = (tools: ToolSet, command: string) =>
		call(tools, "run_command", { command, timeout_seconds: 30 }).then((result) =>
			String(result.stdout).trim(),
		);

	it(
		"starts commands in the thread's folder, with the agent's home as HOME",
		async () => {
			const tools = await toolsFor("turn-1", "thread-a", "agent-1");

			expect(await run(tools, "pwd")).toBe(`${Sandboxes.WORKSPACE_DIRECTORY}/threads/thread-a`);
			expect(await run(tools, "echo $HOME")).toBe(
				`${Sandboxes.WORKSPACE_DIRECTORY}/agents/agent-1`,
			);
		},
		SLOW,
	);

	it(
		"keeps a thread's files for its next turn, and apart from other threads",
		async () => {
			const first = await toolsFor("turn-2", "thread-b", "agent-1");
			await call(first, "write_file", { path: "notes.txt", content: "thread b" });

			const later = await toolsFor("turn-3", "thread-b", "agent-2");
			const elsewhere = await toolsFor("turn-4", "thread-c", "agent-1");

			expect((await call(later, "read_file", { path: "notes.txt" })).content).toBe("thread b");
			expect((await call(elsewhere, "read_file", { path: "notes.txt" })).status).toBe("failed");
		},
		SLOW,
	);

	it(
		"keeps an agent's home across its threads",
		async () => {
			const one = await toolsFor("turn-5", "thread-d", "agent-3");
			await run(one, "echo remembered > ~/memo");
			const other = await toolsFor("turn-6", "thread-e", "agent-3");

			expect(await run(other, "cat ~/memo")).toBe("remembered");
		},
		SLOW,
	);

	it(
		"reaches the trusted hosts, and a host the workspace adds at once",
		async () => {
			const tools = await toolsFor("turn-8", "thread-g", "agent-5");
			const reaches = async (host: string) =>
				(await run(
					tools,
					`curl -s -o /dev/null --max-time 10 https://${host} && echo yes || echo no`,
				)) === "yes";
			expect([await reaches("github.com"), await reaches("example.com")]).toEqual([true, false]);

			await onDatabase((db) =>
				db
					.insert(sandboxAllowedHost)
					.values({ workspaceId: thePod.workspaceId, host: "example.com" }),
			);
			await runOnPostgres(podSandboxes.applyAllowedHosts({ workspaceId: thePod.workspaceId }));

			expect(await reaches("example.com")).toBe(true);
		},
		SLOW,
	);
});
