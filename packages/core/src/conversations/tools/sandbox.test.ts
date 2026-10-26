import { createHash } from "node:crypto";
import type { ToolSet } from "ai";
import { Effect, Exit, Layer, Scope, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	agent,
	message,
	pod,
	sandboxAllowedHost,
	thread,
	user,
	workspace,
	workspaceMember,
} from "../../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../../database/testing.ts";
import { PodSandboxes } from "../../sandboxes/pod-sandboxes.ts";
import { SandboxCredentials } from "../../sandboxes/sandbox-credentials.ts";
import { SandboxProviderRepository } from "../../sandboxes/sandbox-provider-repository.ts";
import { Sandboxes } from "../../sandboxes/sandboxes.ts";
import { ThreadFiles } from "../thread-files/thread-files.ts";
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
	let ownerId: string;
	const scope = Effect.runSync(Scope.make());

	beforeAll(async () => {
		[sandboxTools, podSandboxes] = await runOnPostgres(
			Effect.all([SandboxTools.Service, PodSandboxes.Service]).pipe(
				Effect.provide(Layer.merge(SandboxTools.layer, PodSandboxes.layer)),
				Effect.provide(SandboxCredentials.none),
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
		ownerId = owner.id;
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
					settings: {
						preset: "opensandbox",
						serverUrl: env.OPENSANDBOX_URL,
						// The default image, for its browser: `bun run build:sandbox` first.
						image: "ghcr.io/nitrictech/sugabots-sandbox:latest",
						networkMode: "allowlist",
					},
					enabled: true,
					apiKey: env.OPENSANDBOX_API_KEY,
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

	const toolsFor = (
		turnId: string,
		threadId: string,
		agentId: string,
		attach?: SandboxTools.Turn["attach"],
	) =>
		runOnPostgres(
			Scope.provide(scope)(
				sandboxTools.forTurn({
					pod: thePod,
					usesSandbox: true,
					turnId,
					threadId,
					agentId,
					acceptsImages: false,
					...(attach && { attach }),
				}),
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
		"copies a file in the thread into its folder when asked, under a safe name",
		async () => {
			const [host] = await onDatabase((db) =>
				db
					.insert(agent)
					.values({
						workspaceId: thePod.workspaceId,
						podId: thePod.podId,
						name: "Editor",
						handle: `editor-${Date.now()}`,
						color: "green",
						face: "pill",
					})
					.returning(),
			);
			if (!host) throw new Error("fixture");
			const newThread = async (title: string) => {
				const [made] = await onDatabase((db) =>
					db
						.insert(thread)
						.values({
							workspaceId: thePod.workspaceId,
							podId: thePod.podId,
							hostAgentId: host.id,
							type: "collaboration",
							title,
						})
						.returning(),
				);
				if (!made) throw new Error("fixture");
				return made;
			};
			const where = await newThread("Pictures");
			const [sent] = await onDatabase((db) =>
				db
					.insert(message)
					.values({
						threadId: where.id,
						authorUserId: ownerId,
						kind: "text",
						status: "complete",
						parts: [],
						content: "",
					})
					.returning(),
			);
			if (!sent) throw new Error("fixture");
			// Not text: a NUL and bytes that aren't UTF-8 must come through as they are.
			const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0a]);
			const files = await runOnPostgres(Effect.provide(ThreadFiles.Service, ThreadFiles.layer));
			const uploaded = await runOnPostgres(
				files.upload({
					threadId: where.id,
					uploaderId: ownerId,
					name: "../dot.png",
					maxSize: 1_000,
					maxUnsent: 20,
					content: { stream: Stream.succeed(bytes), contentType: "image/png" },
				}),
			);
			await runOnPostgres(
				files.attach({
					threadId: where.id,
					messageId: sent.id,
					uploaderId: ownerId,
					fileIds: [uploaded.id],
				}),
			);
			const tools = await toolsFor("turn-9", where.id, host.id);
			const hash = createHash("sha256").update(bytes).digest("hex");

			const path = `attachments/${uploaded.id}/_dot.png`;
			const copy = () => call(tools, "copy_file_to_sandbox", { file: uploaded.id });

			expect(await copy()).toMatchObject({ path, alreadyCopied: false });
			expect(await run(tools, `sha256sum ${path} | cut -d' ' -f1`)).toBe(hash);
			// Nothing half copied is left beside it.
			expect(await run(tools, `ls -A attachments/${uploaded.id}`)).toBe("_dot.png");

			// Copying again keeps the changes made to the copy.
			await run(tools, `echo inverted > ${path}`);
			expect(await copy()).toMatchObject({ path, alreadyCopied: true });
			expect(await run(tools, `cat ${path}`)).toBe("inverted");

			await run(tools, `rm ${path}`);
			expect(await copy()).toMatchObject({ path, alreadyCopied: false });
			expect(await run(tools, `sha256sum ${path} | cut -d' ' -f1`)).toBe(hash);

			const elsewhere = await toolsFor("turn-10", (await newThread("Other")).id, host.id);
			expect(await call(elsewhere, "copy_file_to_sandbox", { file: uploaded.id })).toMatchObject({
				status: "failed",
			});
		},
		SLOW,
	);

	it(
		"attaches a file from the sandbox to the reply, read as it is, and refuses one too large",
		async () => {
			const attached: { name: string; contentType: string; content: Uint8Array }[] = [];
			const tools = await toolsFor("turn-12", "thread-h", "agent-7", (file) => {
				attached.push(file);
				return Effect.succeed({
					type: "file" as const,
					id: `file-${attached.length}`,
					name: file.name,
					contentType: file.contentType,
					size: file.content.byteLength,
				});
			});
			// A PNG's signature, then bytes that aren't text.
			await run(
				tools,
				String.raw`mkdir -p out && printf '\x89PNG\r\n\x1a\n\x00\xff' > out/chart.png`,
			);
			await run(tools, String.raw`printf 'region,total\nnorth,4\n' > report.csv`);
			await run(tools, "truncate -s 11M big.bin");

			expect(await call(tools, "share_file", { path: "out/chart.png" })).toMatchObject({
				shared: "chart.png",
				file: "file-1",
			});
			expect(
				await call(tools, "share_file", { path: "report.csv", name: "../Q3 totals.csv" }),
			).toMatchObject({
				shared: "_Q3 totals.csv",
			});
			expect(attached.map(({ name, contentType }) => ({ name, contentType }))).toEqual([
				{ name: "chart.png", contentType: "image/png" },
				{ name: "_Q3 totals.csv", contentType: "text/csv; charset=utf-8" },
			]);
			expect([...(attached[0]?.content ?? [])]).toEqual([
				0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff,
			]);

			expect(await call(tools, "share_file", { path: "big.bin" })).toMatchObject({
				status: "failed",
				error: expect.stringContaining("files up to 10 MB"),
			});
			expect(await call(tools, "share_file", { path: "nowhere.png" })).toMatchObject({
				status: "failed",
			});
			expect(attached).toHaveLength(2);
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
			await runOnPostgres(podSandboxes.applyNetwork({ workspaceId: thePod.workspaceId }));

			expect(await reaches("example.com")).toBe(true);
		},
		SLOW,
	);

	it(
		"drives a browser of the agent's own, and leaves out screenshots for a model that can't see them",
		async () => {
			const tools = await toolsFor("turn-7", "thread-f", "agent-4");

			const opened = await call(tools, "browser_navigate", {
				url: "data:text/html,<title>Sugabots</title><h1>Hello from the sandbox</h1>",
			});
			const snapshot = await call(tools, "browser_snapshot", {});

			expect(String(opened.text)).toContain("Your browser has just started");
			expect(String(snapshot.text)).toContain("Hello from the sandbox");
			expect(tools.browser_take_screenshot).toBeUndefined();
		},
		SLOW,
	);
});
