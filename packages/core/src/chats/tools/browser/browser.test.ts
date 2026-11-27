import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache, Effect } from "effect";
import { expect, it } from "vitest";
import { Computers } from "../../../computers/computers.ts";
import { effectRunner } from "../../../database/database.ts";
import { placeOf } from "../computer/tools.ts";
import { browserSession, type CachedBrowserSession, startDesktop } from "./browser.ts";

it("moves legacy work before opening a desktop, preserving files already in place", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "desktop-work-"));
	try {
		const bot = { botId: "planner", chatId: "trip", color: "green" } as const;
		const lastChat = randomUUID();
		const place = {
			...placeOf(bot),
			previousChatIds: ["budget", ...Array.from({ length: 1_000 }, () => randomUUID()), lastChat],
		};
		const localPath = (path: string) => path.replace("/workspace", workspace);
		const oldHome = localPath("/workspace/agents/planner");
		const oldChat = localPath("/workspace/threads/trip");
		const helperCheckout = localPath(join(Computers.LEGACY_CHATS_DIRECTORY, "budget/checkout"));
		const lastFolder = localPath(join(Computers.LEGACY_CHATS_DIRECTORY, lastChat));
		const otherCheckout = localPath(join(Computers.CHATS_DIRECTORY, "budget/checkout"));
		for (const folder of [
			join(oldHome, ".config"),
			oldChat,
			helperCheckout,
			lastFolder,
			otherCheckout,
			join(localPath(place.home), ".config"),
			localPath(place.folder),
		]) {
			await mkdir(folder, { recursive: true });
		}
		await writeFile(join(lastFolder, "notes.md"), "last collaboration");
		await writeFile(join(helperCheckout, ".git"), "legacy checkout");
		await writeFile(join(otherCheckout, ".git"), "other checkout");
		await writeFile(join(oldHome, ".profile"), "legacy profile");
		await writeFile(join(oldHome, ".config/preferences"), "legacy preferences");
		await writeFile(join(oldChat, "plan.md"), "legacy plan");
		await writeFile(join(oldChat, "notes.md"), "legacy notes");
		await writeFile(join(workspace, "chats/trip/plan.md"), "current plan");
		await writeFile(
			join(workspace, "sugabots-desktop"),
			"#!/bin/sh\nprintf 'viewer=5900 watch=5901 password=control watch-password=watch\n'\n",
			{ mode: 0o755 },
		);
		const unused = () => Effect.die("Desktop opening only runs commands");
		const computer: Computers.Computer = {
			id: Computers.ComputerId("desktop-test"),
			exec: (command) =>
				Effect.sync(() => {
					const ran = spawnSync("bash", ["-c", command.replaceAll("/workspace", workspace)], {
						encoding: "utf8",
						env: { ...process.env, PATH: `${workspace}:${process.env.PATH}` },
					});
					if (ran.error) throw ran.error;
					return {
						exitCode: ran.status,
						stdout: { text: ran.stdout, truncated: false },
						stderr: { text: ran.stderr, truncated: false },
					};
				}),
			readFile: unused,
			writeFile: unused,
			downloadFile: unused,
			uploadFile: unused,
			endpoint: unused,
			setNetwork: unused,
		};
		await Effect.runPromise(startDesktop(computer, place, bot));
		expect(await readFile(join(workspace, "bots/planner/.profile"), "utf8")).toBe("legacy profile");
		expect(await readFile(join(workspace, "bots/planner/.config/preferences"), "utf8")).toBe(
			"legacy preferences",
		);
		expect(await readFile(join(workspace, "chats/trip/notes.md"), "utf8")).toBe("legacy notes");
		expect(await readFile(join(workspace, "chats/trip/plan.md"), "utf8")).toBe("current plan");
		expect(await readFile(join(oldChat, "plan.md"), "utf8")).toBe("legacy plan");
		await expect(readFile(join(oldChat, "notes.md"))).rejects.toHaveProperty("code", "ENOENT");
		expect(
			await readFile(join(workspace, "chats/trip/collaborations/budget/checkout/.git"), "utf8"),
		).toBe("legacy checkout");
		expect(
			await readFile(
				join(workspace, "chats/trip/collaborations/budget-chats/checkout/.git"),
				"utf8",
			),
		).toBe("other checkout");
		expect(
			await readFile(join(workspace, "chats/trip/collaborations", lastChat, "notes.md"), "utf8"),
		).toBe("last collaboration");
		await expect(readFile(join(helperCheckout, ".git"))).rejects.toHaveProperty("code", "ENOENT");
		await expect(readFile(join(otherCheckout, ".git"))).rejects.toHaveProperty("code", "ENOENT");
		await Effect.runPromise(startDesktop(computer, place, bot));
		expect(await readFile(join(workspace, "chats/trip/plan.md"), "utf8")).toBe("current plan");
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

it.each(["step closes", "termination times out"])(
	"aborts a stalled session DELETE when the %s",
	async (ending) => {
		const bot = {
			botId: "planner",
			chatId: "trip",
			color: "green",
			naturalBrowsing: false,
		} as const;
		const sessions = await Effect.runPromise(
			Cache.make({
				capacity: 1,
				lookup: (_key: string): Effect.Effect<CachedBrowserSession | undefined> => Effect.undefined,
			}),
		);
		const browser = browserSession(
			effectRunner({ runPromiseExit: Effect.runPromiseExit }),
			placeOf(bot),
			bot,
			"provider",
			sessions,
		);
		const deleting = Promise.withResolvers<AbortSignal>();
		const deleted = Promise.withResolvers<Response>();
		const fetchMcp: typeof fetch = async (url, init) => {
			const request = new Request(url, init);
			if (request.method === "DELETE") {
				deleting.resolve(request.signal);
				request.signal.addEventListener("abort", () => deleted.reject(request.signal.reason), {
					once: true,
				});
				return deleted.promise;
			}
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const { id, method, params } = (await request.json()) as {
				id?: number;
				method: string;
				params?: { protocolVersion?: string };
			};
			if (method === "notifications/initialized") return new Response(null, { status: 202 });
			const result =
				method === "initialize"
					? {
							protocolVersion: params?.protocolVersion,
							capabilities: { tools: {} },
							serverInfo: { name: "browser-test", version: "1" },
						}
					: { content: [{ type: "text", text: "Closed browser" }] };
			return Response.json(
				{ jsonrpc: "2.0", id, result },
				{ headers: { "mcp-session-id": "browser-session" } },
			);
		};
		const unused = () => Effect.die("Closing the browser only runs commands and makes requests");
		const computer: Computers.Computer = {
			id: Computers.ComputerId("browser-test"),
			exec: () =>
				Effect.succeed({
					exitCode: 0,
					stdout: {
						text: "viewer=5900 watch=5901 browser=9222 password=control watch-password=watch",
						truncated: false,
					},
					stderr: { text: "", truncated: false },
				}),
			endpoint: () =>
				Effect.succeed({ url: "http://computer.example", headers: {}, fetch: fetchMcp }),
			readFile: unused,
			writeFile: unused,
			downloadFile: unused,
			uploadFile: unused,
			setNetwork: unused,
		};
		const closing = browser.call(computer, "browser_close", {}, undefined);
		try {
			const signal = await deleting.promise;
			if (ending === "step closes") await browser.close();
			else {
				const deadline = AbortSignal.timeout(3_000);
				await Promise.race([
					closing,
					new Promise((_, reject) =>
						deadline.addEventListener("abort", () => reject(deadline.reason), { once: true }),
					),
				]);
			}
			expect(signal.aborted).toBe(true);
		} finally {
			deleted.resolve(new Response(null, { status: 204 }));
			await closing;
			await browser.close();
		}
	},
);
