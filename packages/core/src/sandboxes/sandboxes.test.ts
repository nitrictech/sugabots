import { Cause, Effect, Exit, Layer, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ids } from "../ids/ids.ts";
import { Sandboxes } from "./sandboxes.ts";

/**
 * The same behaviour from every provider, run against the real service.
 *
 * Each provider runs only when its environment is set:
 * - OpenSandbox: `docker compose --profile sandboxes up -d`, then
 *   OPENSANDBOX_URL=http://localhost:8090 and OPENSANDBOX_API_KEY.
 * - E2B: E2B_API_KEY, plus E2B_API_URL and E2B_SANDBOX_URL for E2B Embed.
 */
const env = process.env;

const connections: ReadonlyArray<[string, Sandboxes.Connection | undefined]> = [
	[
		"OpenSandbox",
		env.OPENSANDBOX_URL && env.OPENSANDBOX_API_KEY
			? {
					provider: "opensandbox",
					baseUrl: env.OPENSANDBOX_URL,
					apiKey: Redacted.make(env.OPENSANDBOX_API_KEY),
					// Debian with Python, for a web server to reach.
					image: "python:3.13-slim",
				}
			: undefined,
	],
	[
		"E2B",
		env.E2B_API_KEY
			? {
					provider: "e2b",
					apiKey: Redacted.make(env.E2B_API_KEY),
					template: "base",
					...(env.E2B_API_URL && env.E2B_SANDBOX_URL
						? { endpoints: { apiUrl: env.E2B_API_URL, sandboxUrl: env.E2B_SANDBOX_URL } }
						: {}),
				}
			: undefined,
	],
];

const SPEC: Sandboxes.Spec = {
	labels: { "sugabots.test": "sandboxes.test.ts" },
	allowedHosts: ["example.com"],
	// One name for every run, so a provider that keeps work apart reuses one volume.
	workName: "provider-tests",
};
const EXEC = { timeout: "30 seconds", maxOutputCharacters: 10_000 } as const;
const SLOW = 180_000;

const run = <A, E>(effect: Effect.Effect<A, E, Sandboxes.Service>) =>
	Effect.runPromise(effect.pipe(Effect.provide(Sandboxes.layer.pipe(Layer.provide(Ids.layer)))));

const runExit = <A, E>(effect: Effect.Effect<A, E, Sandboxes.Service>) =>
	Effect.runPromiseExit(
		effect.pipe(Effect.provide(Sandboxes.layer.pipe(Layer.provide(Ids.layer)))),
	);

/** A command that succeeds only if an HTTPS request to `host` gets an answer. */
function reachScript(host: string) {
	return `python3 -c "import urllib.request; urllib.request.urlopen('https://${host}', timeout=10)"`;
}

function failureTag(exit: Exit.Exit<unknown, { _tag: string }>) {
	if (Exit.isSuccess(exit)) return "success";
	const failure = exit.cause.reasons.find(Cause.isFailReason);
	return failure ? failure.error._tag : Cause.pretty(exit.cause);
}

describe.each(connections)("%s sandboxes", (_, connection) => {
	describe.skipIf(!connection)("against the service", () => {
		const provider = Effect.map(Sandboxes.Service, (sandboxes) =>
			sandboxes.forConnection(connection as Sandboxes.Connection),
		);
		let sandbox: Sandboxes.Sandbox;

		beforeAll(async () => {
			sandbox = await run(Effect.flatMap(provider, (p) => p.create(SPEC)));
		}, SLOW);

		afterAll(async () => {
			if (sandbox) await run(Effect.flatMap(provider, (p) => p.destroy(sandbox.id)));
		}, SLOW);

		it("accepts the key", async () => {
			expect(failureTag(await runExit(Effect.flatMap(provider, (p) => p.check)))).toBe("success");
		});

		it(
			"reaches only the hosts it is allowed, and changes them while it runs",
			async () => {
				const reaches = async (host: string) =>
					(await run(sandbox.exec(reachScript(host), EXEC))).exitCode === 0;

				expect([await reaches("example.com"), await reaches("github.com")]).toEqual([true, false]);
				await run(sandbox.setAllowedHosts(["github.com"]));
				expect([await reaches("example.com"), await reaches("github.com")]).toEqual([false, true]);
				await run(sandbox.setAllowedHosts(SPEC.allowedHosts));
			},
			SLOW,
		);

		it("runs commands in the workspace, as a user who isn't root", async () => {
			const execution = await run(sandbox.exec("pwd; id -u", EXEC));

			expect(execution.exitCode).toBe(0);
			const [directory, userId] = execution.stdout.text.trim().split("\n");
			expect(directory).toBe(Sandboxes.WORKSPACE_DIRECTORY);
			expect(userId).not.toBe("0");
		});

		it("answers a failing command with its exit code and output", async () => {
			const execution = await run(sandbox.exec("echo nope >&2; exit 3", EXEC));

			expect(execution.exitCode).toBe(3);
			expect(execution.stderr.text).toContain("nope");
		});

		it("keeps the end of long output", async () => {
			const execution = await run(sandbox.exec("seq 1 1000", { ...EXEC, maxOutputCharacters: 20 }));

			expect(execution.stdout.text.trim().endsWith("1000")).toBe(true);
			expect(execution.stdout.text.length).toBeLessThanOrEqual(20);
			expect(execution.stdout.truncated).toBe(true);
		});

		it("keeps the end of a command's stderr, and its exit code, past a flood of stdout", async () => {
			const execution = await run(
				sandbox.exec("head -c 50000000 /dev/zero; echo done >&2; exit 4", {
					...EXEC,
					maxOutputCharacters: 100,
				}),
			);

			expect(execution.exitCode).toBe(4);
			expect(execution.stdout.text.length).toBeLessThanOrEqual(100);
			expect(execution.stderr.text.trim()).toBe("done");
		});

		it("returns when a command does, though what it started in the background runs on", async () => {
			const started = Date.now();
			const execution = await run(
				sandbox.exec("(sleep 60 >/dev/null 2>&1 &); echo started", {
					...EXEC,
					timeout: "20 seconds",
				}),
			);

			expect(execution.stdout.text.trim()).toBe("started");
			expect(Date.now() - started).toBeLessThan(10_000);
		}, 60_000);

		it("stops a command at its timeout, with no exit code", async () => {
			const execution = await run(sandbox.exec("sleep 30", { ...EXEC, timeout: "2 seconds" }));

			expect(execution.exitCode).toBeNull();
		}, 60_000);

		it("passes environment variables to the command", async () => {
			const execution = await run(
				sandbox.exec("echo $GREETING", { ...EXEC, env: { GREETING: "hi" } }),
			);

			expect(execution.stdout.text.trim()).toBe("hi");
		});

		it("writes files the agents' user owns, making their directories", async () => {
			const path = `${Sandboxes.WORKSPACE_DIRECTORY}/notes/today.txt`;
			const content = new TextEncoder().encode("written by a test\n");

			await run(sandbox.writeFile(path, content));

			const read = await run(sandbox.readFile(path, 1_000));
			expect(new TextDecoder().decode(read.content)).toBe("written by a test\n");
			const owner = await run(sandbox.exec(`test "$(stat -c %u ${path})" = "$(id -u)"`, EXEC));
			expect(owner.exitCode).toBe(0);
		});

		it("refuses to read a file that doesn't exist", async () => {
			const exit = await runExit(
				sandbox.readFile(`${Sandboxes.WORKSPACE_DIRECTORY}/missing.txt`, 1_000),
			);

			expect(failureTag(exit)).toBe("SandboxFileFailed");
		});

		it("reads only the start of a large file, with its whole size", async () => {
			const path = `${Sandboxes.WORKSPACE_DIRECTORY}/large.bin`;
			await run(sandbox.exec(`truncate -s 1G ${path}`, EXEC));

			const read = await run(sandbox.readFile(path, 10));

			expect(read.content.length).toBe(10);
			expect(read.sizeBytes).toBe(1024 ** 3);
		});

		it("refuses to read what isn't a regular file", async () => {
			const exit = await runExit(sandbox.readFile("/dev/zero", 10));

			expect(failureTag(exit)).toBe("SandboxFileFailed");
		});

		it("reads and writes files only as the agents' user may", async () => {
			const read = await runExit(sandbox.readFile("/etc/shadow", 1_000));
			const written = await runExit(
				sandbox.writeFile("/etc/sugabots-test", new TextEncoder().encode("x")),
			);

			expect(failureTag(read)).toBe("SandboxFileFailed");
			expect(failureTag(written)).toBe("SandboxFileFailed");
		});

		it(
			"reports whether it runs, and the image it was made from",
			async () => {
				const made = await run(Effect.flatMap(provider, (p) => p.create(SPEC)));
				const info = (id: Sandboxes.SandboxId) => run(Effect.flatMap(provider, (p) => p.info(id)));

				const running = await info(made.id);
				await run(Effect.flatMap(provider, (p) => p.pause(made.id)));
				const paused = await info(made.id);
				await run(Effect.flatMap(provider, (p) => p.destroy(made.id)));

				expect(running.state).toBe("running");
				expect(running.image).toContain(
					connection?.provider === "e2b"
						? connection.template
						: (connection as Sandboxes.OpenSandboxConnection).image,
				);
				expect(paused.state).toBe("paused");
			},
			SLOW,
		);

		it(
			"keeps files across a pause, and says when opening resumed it",
			async () => {
				await run(sandbox.exec("echo kept > kept.txt", EXEC));

				const running = await run(Effect.flatMap(provider, (p) => p.open(sandbox.id)));
				await run(Effect.flatMap(provider, (p) => p.pause(sandbox.id)));
				const paused = await run(Effect.flatMap(provider, (p) => p.open(sandbox.id)));
				sandbox = paused.sandbox;

				expect(running.resumed).toBe(false);
				expect(paused.resumed).toBe(true);
				expect((await run(sandbox.exec("cat kept.txt", EXEC))).stdout.text.trim()).toBe("kept");
			},
			SLOW,
		);
	});

	describe.skipIf(!connection)("a destroyed sandbox", () => {
		it(
			"is missing, and destroying it again succeeds",
			async () => {
				const sandboxes = Effect.map(Sandboxes.Service, (s) =>
					s.forConnection(connection as Sandboxes.Connection),
				);
				const made = await run(Effect.flatMap(sandboxes, (p) => p.create(SPEC)));

				await run(Effect.flatMap(sandboxes, (p) => p.destroy(made.id)));

				expect(failureTag(await runExit(Effect.flatMap(sandboxes, (p) => p.open(made.id))))).toBe(
					"SandboxMissing",
				);
				expect(
					failureTag(await runExit(Effect.flatMap(sandboxes, (p) => p.destroy(made.id)))),
				).toBe("success");
			},
			SLOW,
		);
	});
});

describe.skipIf(!env.E2B_API_KEY)("E2B templates, against the service", () => {
	it("builds a template from an image, then makes sandboxes from it", async () => {
		const connection: Sandboxes.E2bConnection = {
			provider: "e2b",
			apiKey: Redacted.make(env.E2B_API_KEY ?? ""),
			template: `sugabots-test-${Date.now()}`,
			...(env.E2B_API_URL && env.E2B_SANDBOX_URL
				? { endpoints: { apiUrl: env.E2B_API_URL, sandboxUrl: env.E2B_SANDBOX_URL } }
				: {}),
		};
		const provider = await run(Effect.map(Sandboxes.Service, (s) => s.forConnection(connection)));
		const templates = provider.templates;
		if (!templates) throw new Error("E2B builds templates");

		const build = await run(templates.build("python:3.13-slim"));
		let status = await run(templates.status(build));
		while (status === "building") {
			await new Promise((resolve) => setTimeout(resolve, 3_000));
			status = await run(templates.status(build));
		}
		const made = await run(provider.create(SPEC));
		const python = await run(made.exec("python3 --version", EXEC));
		await run(provider.destroy(made.id));

		expect(status).toBe("ready");
		expect(python.stdout.text).toContain("Python 3.13");
	}, 600_000);

	it("says so when the workspace's template hasn't been built", async () => {
		const provider = await run(
			Effect.map(Sandboxes.Service, (s) =>
				s.forConnection({
					provider: "e2b",
					apiKey: Redacted.make(env.E2B_API_KEY ?? ""),
					template: "sugabots-never-built",
					...(env.E2B_API_URL && env.E2B_SANDBOX_URL
						? { endpoints: { apiUrl: env.E2B_API_URL, sandboxUrl: env.E2B_SANDBOX_URL } }
						: {}),
				}),
			),
		);

		const exit = await runExit(provider.create(SPEC));
		const failure = Exit.isFailure(exit)
			? exit.cause.reasons.find(Cause.isFailReason)?.error
			: undefined;

		expect(failure?.userMessage).toContain("E2B template isn't ready");
	});
});
