import { COMPUTER_E2B_DEFAULT_SIZE, COMPUTER_OPENSANDBOX_DEFAULT_SIZE } from "@sugabots/contracts";
import { Cause, Effect, Exit, Layer, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ids } from "../ids/ids.ts";
import { Computers } from "./computers.ts";
import { localComputerEgress, removeWorkVolumes } from "./testing.ts";

/**
 * The same behaviour from every provider, run against the real service.
 *
 * Each provider runs only when its environment is set:
 * - OpenSandbox: `docker compose --profile computers up -d`, then
 *   OPENSANDBOX_URL=http://localhost:8090 and OPENSANDBOX_API_KEY.
 * - E2B: E2B_API_KEY, plus E2B_API_URL and E2B_SANDBOX_URL for E2B Embed.
 */
const env = process.env;

/** E2B, or E2B Embed when its endpoints are set, from the environment. */
const e2b: Computers.E2bAccess | undefined = env.E2B_API_KEY
	? {
			provider: "e2b",
			apiKey: Redacted.make(env.E2B_API_KEY),
			template: "base",
			size: COMPUTER_E2B_DEFAULT_SIZE,
			networkMode: "allowed-hosts-only",
			...(env.E2B_API_URL && env.E2B_SANDBOX_URL
				? { endpoints: { apiUrl: env.E2B_API_URL, sandboxUrl: env.E2B_SANDBOX_URL } }
				: {}),
		}
	: undefined;

const accesses: ReadonlyArray<[string, Computers.ProviderAccess | undefined]> = [
	[
		"OpenSandbox",
		env.OPENSANDBOX_URL && env.OPENSANDBOX_API_KEY
			? {
					provider: "opensandbox",
					baseUrl: env.OPENSANDBOX_URL,
					apiKey: Redacted.make(env.OPENSANDBOX_API_KEY),
					// Debian with Python, for a web server to reach.
					image: "python:3.13-slim",
					size: COMPUTER_OPENSANDBOX_DEFAULT_SIZE,
					networkMode: "allowed-hosts-only",
				}
			: undefined,
	],
	["E2B", e2b],
];

const SPEC: Computers.Spec = {
	labels: { "sugabots.test": "computers.test.ts" },
	reach: { kind: "allowed-hosts-only", hosts: ["example.com"] },
	// This run's own, so removing its volume afterwards can't affect another run.
	workName: `provider-${crypto.randomUUID()}`,
};
const EXEC = { timeout: "30 seconds", maxOutputCharacters: 10_000 } as const;
const SLOW = 180_000;

const run = <A, E>(effect: Effect.Effect<A, E, Computers.Service>) =>
	Effect.runPromise(
		effect.pipe(
			Effect.provide(Computers.layer.pipe(Layer.provide([Ids.layer, localComputerEgress]))),
		),
	);

const runExit = <A, E>(effect: Effect.Effect<A, E, Computers.Service>) =>
	Effect.runPromiseExit(
		effect.pipe(
			Effect.provide(Computers.layer.pipe(Layer.provide([Ids.layer, localComputerEgress]))),
		),
	);

/** A command that succeeds only if an HTTPS request to `host` gets an answer. */
function reachScript(host: string) {
	return `python3 -c "import urllib.request; urllib.request.urlopen('https://${host}', timeout=10)"`;
}

/** A command that prints what an HTTPS request to `url` answers. */
function echoScript(url: string) {
	return `python3 -c "import urllib.request; print(urllib.request.urlopen('${url}', timeout=20).read().decode())"`;
}

function failureTag(exit: Exit.Exit<unknown, { _tag: string }>) {
	if (Exit.isSuccess(exit)) return "success";
	const failure = exit.cause.reasons.find(Cause.isFailReason);
	return failure ? failure.error._tag : Cause.pretty(exit.cause);
}

describe.each(accesses)("%s computers", (_, access) => {
	afterAll(() => {
		if (access?.provider === "opensandbox") removeWorkVolumes([SPEC.workName]);
	});

	describe.skipIf(!access)("against the service", () => {
		const provider = Effect.map(Computers.Service, (computers) =>
			computers.forAccess(access as Computers.ProviderAccess),
		);
		let computer: Computers.Computer;
		const reaches = async (host: string) =>
			(await run(computer.exec(reachScript(host), EXEC))).exitCode === 0;

		beforeAll(async () => {
			computer = await run(Effect.flatMap(provider, (p) => p.create(SPEC)));
		}, SLOW);

		afterAll(async () => {
			if (computer) await run(Effect.flatMap(provider, (p) => p.destroy(computer.id)));
		}, SLOW);

		it("accepts the key", async () => {
			expect(failureTag(await runExit(Effect.flatMap(provider, (p) => p.check)))).toBe("success");
		});

		it(
			"reaches only the hosts it is allowed, and changes them while it runs",
			async () => {
				expect([await reaches("example.com"), await reaches("github.com")]).toEqual([true, false]);
				await run(
					computer.setNetwork({
						reach: { kind: "allowed-hosts-only", hosts: ["github.com"] },
						credentials: [],
					}),
				);
				expect([await reaches("example.com"), await reaches("github.com")]).toEqual([false, true]);
				await run(computer.setNetwork({ reach: SPEC.reach, credentials: [] }));
			},
			SLOW,
		);

		it(
			"reaches every host when open, but the blocked ones where it can block, and goes back to allowed hosts only",
			async () => {
				const { blocksHosts } = (await run(provider)).capabilities;
				await run(
					computer.setNetwork({
						reach: { kind: "open", blockedHosts: blocksHosts ? ["github.com"] : [] },
						credentials: [],
					}),
				);
				const open = [await reaches("example.com"), await reaches("github.com")];
				await run(computer.setNetwork({ reach: SPEC.reach, credentials: [] }));
				const allowedHostsOnly = [await reaches("example.com"), await reaches("github.com")];

				expect(open).toEqual([true, !blocksHosts]);
				expect(allowedHostsOnly).toEqual([true, false]);
			},
			SLOW,
		);

		it(
			"adds credentials to its HTTPS requests outside it, never inside it",
			async () => {
				const { credentials: scope } = (await run(provider)).capabilities;
				// A provider that can't add credentials is never given any.
				if (scope === "none") return;
				const echoed = async (path: string) =>
					(await run(computer.exec(echoScript(`https://httpbin.org${path}`), EXEC))).stdout.text;

				await run(
					computer.setNetwork({
						reach: { kind: "allowed-hosts-only", hosts: ["httpbin.org"] },
						credentials: [
							{
								host: "httpbin.org",
								pathPrefix: scope === "host-and-path" ? "/anything/signed/" : undefined,
								header: "X-Sugabots-Test",
								value: Redacted.make("the-credential"),
							},
						],
					}),
				);
				const signed = await echoed("/anything/signed/repository");
				const elsewhere = await echoed("/anything/other/repository");
				const shell = await run(computer.exec("bash -lc 'env'", EXEC));
				await run(computer.setNetwork({ reach: SPEC.reach, credentials: [] }));

				expect(signed).toContain("the-credential");
				if (scope === "host-and-path") expect(elsewhere).not.toContain("the-credential");
				expect(shell.stdout.text).not.toContain("the-credential");
			},
			SLOW,
		);

		it("runs commands in the workspace, as a user who isn't root", async () => {
			const execution = await run(computer.exec("pwd; id -u", EXEC));

			expect(execution.exitCode).toBe(0);
			const [directory, uid] = execution.stdout.text.trim().split("\n");
			expect(directory).toBe(Computers.WORK_DIRECTORY);
			expect(uid).not.toBe("0");
		});

		it("answers a failing command with its exit code and output", async () => {
			const execution = await run(computer.exec("echo nope >&2; exit 3", EXEC));

			expect(execution.exitCode).toBe(3);
			expect(execution.stderr.text).toContain("nope");
		});

		it("keeps the end of long output", async () => {
			const execution = await run(
				computer.exec("seq 1 1000", { ...EXEC, maxOutputCharacters: 20 }),
			);

			expect(execution.stdout.text.trim().endsWith("1000")).toBe(true);
			expect(execution.stdout.text.length).toBeLessThanOrEqual(20);
			expect(execution.stdout.truncated).toBe(true);
		});

		it("keeps the end of a command's stderr, and its exit code, past a flood of stdout", async () => {
			const execution = await run(
				computer.exec("head -c 50000000 /dev/zero; echo done >&2; exit 4", {
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
				computer.exec("(sleep 60 >/dev/null 2>&1 &); echo started", {
					...EXEC,
					timeout: "20 seconds",
				}),
			);

			expect(execution.stdout.text.trim()).toBe("started");
			expect(Date.now() - started).toBeLessThan(10_000);
		}, 60_000);

		it("stops a command at its timeout, with no exit code", async () => {
			const execution = await run(computer.exec("sleep 30", { ...EXEC, timeout: "2 seconds" }));

			expect(execution.exitCode).toBeNull();
		}, 60_000);

		it("passes environment variables to the command", async () => {
			const execution = await run(
				computer.exec("echo $GREETING", { ...EXEC, env: { GREETING: "hi" } }),
			);

			expect(execution.stdout.text.trim()).toBe("hi");
		});

		it("writes files the bots' user owns, making their directories", async () => {
			const path = `${Computers.WORK_DIRECTORY}/notes/today.txt`;
			const content = new TextEncoder().encode("written by a test\n");

			await run(computer.writeFile(path, content));

			const read = await run(computer.readFile(path, 1_000));
			expect(new TextDecoder().decode(read.content)).toBe("written by a test\n");
			const owner = await run(computer.exec(`test "$(stat -c %u ${path})" = "$(id -u)"`, EXEC));
			expect(owner.exitCode).toBe(0);
		});

		it("refuses to read a file that doesn't exist", async () => {
			const exit = await runExit(
				computer.readFile(`${Computers.WORK_DIRECTORY}/missing.txt`, 1_000),
			);

			expect(failureTag(exit)).toBe("ComputerFileFailed");
		});

		it("reads only the start of a large file, with its whole size", async () => {
			const path = `${Computers.WORK_DIRECTORY}/large.bin`;
			await run(computer.exec(`truncate -s 1G ${path}`, EXEC));

			const read = await run(computer.readFile(path, 10));

			expect(read.content.length).toBe(10);
			expect(read.sizeBytes).toBe(1024 ** 3);
		});

		it("refuses to read what isn't a regular file", async () => {
			const exit = await runExit(computer.readFile("/dev/zero", 10));

			expect(failureTag(exit)).toBe("ComputerFileFailed");
		});

		it("reads and writes files only as the bots' user may", async () => {
			const read = await runExit(computer.readFile("/etc/shadow", 1_000));
			const written = await runExit(
				computer.writeFile("/etc/sugabots-test", new TextEncoder().encode("x")),
			);

			expect(failureTag(read)).toBe("ComputerFileFailed");
			expect(failureTag(written)).toBe("ComputerFileFailed");
		});

		it(
			"reaches a port inside the computer",
			async () => {
				await run(
					computer.exec(
						"echo reached > reached.txt && (nohup python3 -m http.server 9001 >/dev/null 2>&1 &) && sleep 2",
						EXEC,
					),
				);
				const endpoint = await run(computer.endpoint(9001));

				const response = await fetch(`${endpoint.url}/reached.txt`, { headers: endpoint.headers });

				expect(response.status).toBe(200);
				expect((await response.text()).trim()).toBe("reached");
			},
			SLOW,
		);

		it(
			"reports whether it runs",
			async () => {
				const made = await run(Effect.flatMap(provider, (p) => p.create(SPEC)));
				const info = (id: Computers.ComputerId) => run(Effect.flatMap(provider, (p) => p.info(id)));

				const running = await info(made.id);
				await run(Effect.flatMap(provider, (p) => p.sleep(made.id)));
				const paused = await info(made.id);
				await run(Effect.flatMap(provider, (p) => p.destroy(made.id)));

				expect(running.state).toBe("running");
				expect(paused.state).toBe("asleep");
			},
			SLOW,
		);

		it(
			"keeps files across sleep, and says when opening resumed it",
			async () => {
				await run(computer.exec("echo kept > kept.txt", EXEC));

				const running = await run(Effect.flatMap(provider, (p) => p.open(computer.id)));
				await run(Effect.flatMap(provider, (p) => p.sleep(computer.id)));
				const paused = await run(Effect.flatMap(provider, (p) => p.open(computer.id)));
				computer = paused.computer;

				expect(running.resumed).toBe(false);
				expect(paused.resumed).toBe(true);
				expect((await run(computer.exec("cat kept.txt", EXEC))).stdout.text.trim()).toBe("kept");
			},
			SLOW,
		);
	});

	describe.skipIf(!access)("a destroyed computer", () => {
		it(
			"is missing, and destroying it again succeeds",
			async () => {
				const computers = Effect.map(Computers.Service, (s) =>
					s.forAccess(access as Computers.ProviderAccess),
				);
				const made = await run(Effect.flatMap(computers, (p) => p.create(SPEC)));

				await run(Effect.flatMap(computers, (p) => p.destroy(made.id)));

				expect(failureTag(await runExit(Effect.flatMap(computers, (p) => p.open(made.id))))).toBe(
					"ComputerMissing",
				);
				expect(
					failureTag(await runExit(Effect.flatMap(computers, (p) => p.destroy(made.id)))),
				).toBe("success");
			},
			SLOW,
		);
	});
});

describe.skipIf(!e2b)("E2B templates, against the service", () => {
	/** The environment's E2B with its own template. */
	const withTemplate = (template: string): Computers.E2bAccess => ({
		...(e2b as Computers.E2bAccess),
		template,
	});

	it("builds a template from an image, then makes computers from it", async () => {
		const access: Computers.E2bAccess = {
			...withTemplate(`sugabots-test-${Date.now()}`),
			size: { cpuCount: 2, memoryGiB: 2 },
		};
		const provider = await run(Effect.map(Computers.Service, (s) => s.forAccess(access)));
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
		const cpus = await run(made.exec("nproc", EXEC));
		const tmpMount = await run(
			made.exec("findmnt --noheadings --output FSTYPE --target /tmp", EXEC),
		);
		await run(provider.destroy(made.id));

		expect(status).toBe("ready");
		expect(python.stdout.text).toContain("Python 3.13");
		expect(cpus.stdout.text.trim()).toBe("2");
		expect(tmpMount.stdout.text.trim()).not.toBe("tmpfs");
	}, 600_000);

	it("says so when the workspace's template hasn't been built", async () => {
		const provider = await run(
			Effect.map(Computers.Service, (s) => s.forAccess(withTemplate("sugabots-never-built"))),
		);

		const exit = await runExit(provider.create(SPEC));
		const failure = Exit.isFailure(exit)
			? exit.cause.reasons.find(Cause.isFailReason)?.error
			: undefined;

		expect(failure?.userMessage).toContain("E2B template isn't ready");
	});
});
