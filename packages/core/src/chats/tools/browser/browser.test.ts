import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { Computers } from "../../../computers/computers.ts";
import { placeOf } from "../computer/tools.ts";
import { startDesktop } from "./browser.ts";

it("moves legacy work before opening a desktop, preserving files already in place", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "desktop-work-"));
	try {
		const bot = { botId: "planner", chatId: "trip", color: "green" } as const;
		const place = placeOf(bot);
		const localPath = (path: string) => path.replace("/workspace", workspace);
		const oldHome = localPath("/workspace/agents/planner");
		const oldChat = localPath("/workspace/threads/trip");
		for (const folder of [
			join(oldHome, ".config"),
			oldChat,
			join(localPath(place.home), ".config"),
			localPath(place.folder),
		]) {
			await mkdir(folder, { recursive: true });
		}
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
					const ran = spawnSync("sh", ["-c", command.replaceAll("/workspace", workspace)], {
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
		await Effect.runPromise(startDesktop(computer, place, bot));
		expect(await readFile(join(workspace, "chats/trip/plan.md"), "utf8")).toBe("current plan");
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});
