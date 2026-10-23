import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A Sugabots of its own for capturing the landing page's material: a
 * throwaway Postgres in Docker, migrated and seeded with the showcase, the
 * API on it, and a built web app served in front. Nothing here touches the
 * dev database or the dev servers, and `stop` takes it all down.
 */

export const REPO = new URL("../../../../", import.meta.url).pathname;

/** The showcase's owner, whom every capture signs in as. */
export const OWNER = { email: "anita@fieldnote.test", password: "showcase" };

const POSTGRES_IMAGE = "postgres:18-alpine";
const POSTGRES_USER = "capture";

/** Development-only secrets, as `.env.example` gives them: nothing real is ever stored here. */
const DEVELOPMENT_SECRETS = {
	BETTER_AUTH_SECRET: "development-secret-not-for-production",
	CREDENTIALS_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

export interface Environment {
	/** Where the browser opens the app. */
	appUrl: string;
	/** What the stage and seed scripts run with, to reach the same database. */
	env: NodeJS.ProcessEnv;
	stop(): Promise<void>;
}

export async function start(): Promise<Environment> {
	const databasePort = await freePort();
	const apiPort = await freePort();
	const webPort = await freePort();
	const container = `sugabots-capture-${process.pid}`;
	const databaseUrl = `postgresql://${POSTGRES_USER}:${POSTGRES_USER}@127.0.0.1:${databasePort}/${POSTGRES_USER}`;
	const appUrl = `http://localhost:${webPort}`;
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		NODE_ENV: "development",
		DATABASE_URL: databaseUrl,
		PUBLIC_URL: appUrl,
		PORT: String(apiPort),
		...DEVELOPMENT_SECRETS,
	};
	const children: ChildProcess[] = [];
	const webBuild = mkdtempSync(join(tmpdir(), "sugabots-capture-web-"));
	const stop = async () => {
		for (const child of children) child.kill();
		run("docker", ["rm", "-f", container], { quiet: true });
		rmSync(webBuild, { recursive: true, force: true });
	};
	try {
		step("Starting a throwaway Postgres");
		run("docker", [
			"run",
			"-d",
			"--rm",
			"--name",
			container,
			"-e",
			`POSTGRES_USER=${POSTGRES_USER}`,
			"-e",
			`POSTGRES_PASSWORD=${POSTGRES_USER}`,
			"-e",
			`POSTGRES_DB=${POSTGRES_USER}`,
			"-p",
			`127.0.0.1:${databasePort}:5432`,
			"-v",
			`${join(REPO, "postgres/init")}:/docker-entrypoint-initdb.d:ro`,
			POSTGRES_IMAGE,
		]);
		await waitFor(() => {
			try {
				run("docker", ["exec", container, "pg_isready", "-U", POSTGRES_USER, "-d", POSTGRES_USER], {
					quiet: true,
				});
				return true;
			} catch {
				return false;
			}
		}, "Postgres");

		step("Migrating and seeding the showcase");
		await retry(() =>
			run("node", ["src/database/migrate.ts"], { cwd: join(REPO, "packages/core"), env }),
		);
		run("node", ["packages/demo/src/showcase/seed.ts"], { cwd: REPO, env });
		run("node", ["packages/demo/src/showcase/stage.ts", "sign-in-connections"], {
			cwd: REPO,
			env,
		});

		step("Building the web app");
		run(join(REPO, "packages/web/node_modules/.bin/vite"), ["build", "--outDir", webBuild], {
			cwd: join(REPO, "packages/web"),
			env: { ...env, PORT: undefined },
			quiet: true,
		});

		step("Starting the API and the web app");
		children.push(
			background("node", ["src/index.ts"], { cwd: join(REPO, "packages/server"), env }),
		);
		children.push(
			background(
				join(REPO, "packages/web/node_modules/.bin/vite"),
				["preview", "--outDir", webBuild, "--port", String(webPort), "--strictPort"],
				{
					cwd: join(REPO, "packages/web"),
					env: { ...env, API_URL: `http://127.0.0.1:${apiPort}`, PORT: undefined },
				},
			),
		);
		await waitFor(
			async () => (await fetch(`${appUrl}/api/me`).catch(() => undefined))?.status === 401,
			"the app",
		);
		return { appUrl, env, stop };
	} catch (error) {
		await stop();
		throw error;
	}
}

export function step(what: string) {
	console.log(`· ${what}`);
}

function run(
	command: string,
	args: string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv; quiet?: boolean } = {},
) {
	return execFileSync(command, args, {
		cwd: options.cwd ?? REPO,
		env: options.env ?? process.env,
		stdio: options.quiet ? "ignore" : ["ignore", "ignore", "inherit"],
	});
}

function background(
	command: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv },
) {
	const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: "ignore" });
	child.unref();
	return child;
}

export function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() =>
				typeof address === "object" && address
					? resolve(address.port)
					: reject(new Error("No port")),
			);
		});
	});
}

const WAIT_MILLISECONDS = 60_000;
const POLL_MILLISECONDS = 500;

async function waitFor(ready: () => boolean | Promise<boolean>, what: string) {
	const until = Date.now() + WAIT_MILLISECONDS;
	while (Date.now() < until) {
		if (await ready()) return;
		await new Promise((resolve) => setTimeout(resolve, POLL_MILLISECONDS));
	}
	throw new Error(`${what} didn't start within a minute`);
}

/** Postgres says it is ready a moment before it takes connections from outside the container. */
async function retry(attempt: () => unknown, times = 10) {
	for (let tries = 1; ; tries++) {
		try {
			return attempt();
		} catch (error) {
			if (tries >= times) throw error;
			await new Promise((resolve) => setTimeout(resolve, POLL_MILLISECONDS * 2));
		}
	}
}
