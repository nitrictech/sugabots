import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Route } from "playwright";
import { click, drawCursor, openNewChat, write } from "./app.ts";
import type { Backdrop } from "./backdrops.ts";
import { signedInContext, WORKSPACE } from "./browser.ts";
import { type Environment, REPO, step } from "./environment.ts";
import { type Chrome, chromes, openStage, type Stage } from "./stage.ts";

/**
 * The demo under the hero. Kestrel Freight was charged twice: from Support's
 * handover chat, Anita starts a chat asking Ticket Desk to refund it. Ticket Desk
 * offers to find out why too, asks Billing Engineer, asks before it
 * refunds, and Support's members pick it up from there.
 *
 * Nothing calls a model. The bots' replies, and the teammates who answer as
 * she goes, are played by `packages/demo/src/showcase/stage.ts` on the
 * app's own event stream: Anita's messages and Allow are answered here, and
 * the stage plays what follows.
 */

const LAYOUT = {
	stage: { width: 1920, height: 1080 },
	app: { width: 1280, height: 720 },
	windowWidth: 0.82,
};
/** The sur form in the middle greys, so the dark window stands out against it. */
const BACKDROP: Backdrop = { form: "sur", family: "graphite" };
/** The video plays this much faster than it was acted, so the bots' token stream doesn't drag. */
const SPEED = 1.3;
const FRAMES_PER_SECOND = 30;
/** How long the last frame stays up before the page loops the video, in the finished video's seconds. */
const END_HOLD_SECONDS = 3;
const JPEG_QUALITY = 92;
/** x264's constant quality: lower is sharper and larger. */
const QUALITY = "20";
/** How long a send's answer waits, so the message's own event reaches the page first. */
const EVENT_LEAD_MILLISECONDS = 500;
const OUTPUT = join(REPO, "packages/website/public/demo");
const NAME = "sugabots-demo";

/** The bot Anita starts her chat with, as the sidebar names it. */
const TICKET_DESK = "Ticket Desk";

/** What Anita writes, in the order she writes it. */
const SAYS = {
	refund: "Kestrel Freight was charged twice on 3 Oct. Can you refund the duplicate?",
	goAhead: "Yes please.",
	reassure: "It won't. Billing Engineer found the cause, and #491 fixes it.",
};

interface Scene {
	/** What the scene shows, for whoever edits the story. */
	about: string;
	play(stage: Stage, director: Directing): Promise<void>;
}

/** The director, and a way for a scene to mark the moment the poster is taken from. */
type Directing = Director & { markPoster(): void };

// The cursor only ever goes to what it clicks: there is no time in the cut for it to wander.
const SCENES: Scene[] = [
	{
		about:
			"In Support's handover chat, Lorraine says Kestrel Freight needs a refund. Anita starts a chat with Ticket Desk from the sidebar and asks it to refund Kestrel Freight.",
		async play(stage) {
			await stage.page.waitForTimeout(1200);
			await openNewChat(stage, TICKET_DESK);
			await write(stage, SAYS.refund);
		},
	},
	{
		about:
			"Ticket Desk offers to find out why it happened too, and Anita says yes. It finds both charges in Stripe and asks Billing Engineer why, which answers in the chat.",
		async play(stage) {
			await stage.app
				.getByText("Want me to ask Billing Engineer")
				.first()
				.waitFor({ timeout: 20_000 });
			await stage.page.waitForTimeout(2000);
			await write(stage, SAYS.goAhead);
			await stage.app.getByText("Found it.").first().waitFor({ timeout: 60_000 });
			await stage.page.waitForTimeout(3200);
		},
	},
	{
		about:
			"Ticket Desk asks before it refunds. Anita allows it in the chat, Ticket Desk sums up, and Lorraine thanks it there.",
		async play(stage, director) {
			const allow = stage.app.getByRole("button", { name: /^Allow/ }).first();
			await allow.waitFor({ timeout: 20_000 });
			director.markPoster();
			await stage.page.waitForTimeout(1500);
			await click(stage, allow);
			await stage.app.getByText("I'll let Kestrel know").first().waitFor({ timeout: 30_000 });
			await stage.page.waitForTimeout(2200);
		},
	},
	{
		about:
			"Doreen mentions Anita in Support's handover chat. She sees it marked in her sidebar and answers, and Doreen closes the ticket.",
		async play(stage, director) {
			void director.stage(["cue", "mention"]);
			const support = stage.app.getByRole("link", { name: /^Support\b/ }).first();
			await support.waitFor({ timeout: 20_000 });
			await stage.page.waitForTimeout(1000);
			await click(stage, support);
			await stage.page.waitForTimeout(1000);
			await click(stage, stage.app.getByRole("link", { name: /^Today's tickets/ }).first());
			await stage.page.waitForTimeout(1600);
			await write(stage, SAYS.reassure);
			await stage.app.getByText("I've closed the ticket").first().waitFor({ timeout: 20_000 });
			await stage.page.waitForTimeout(2400);
		},
	},
];

/** How far after the poster's moment it is taken, in the finished video's seconds. */
const POSTER_OFFSET_SECONDS = 0.6;

/** Records the demo once for each system's title bar: `sugabots-demo-mac.mp4` and so on. */
export async function captureVideo(browser: Browser, environment: Environment) {
	for (const chrome of chromes) await captureVideoIn(browser, environment, chrome);
}

async function captureVideoIn(browser: Browser, environment: Environment, chrome: Chrome) {
	const name = `${NAME}-${chrome}`;
	const context = await signedInContext(browser, environment, 1);
	const director = directorFor(environment);
	await director.answerFor(context);
	step(`Video (${chrome}): resetting the story`);
	await director.stage(["reset"]);

	const stage = await openStage(context, environment.appUrl, LAYOUT);
	await stage.setChrome(chrome);
	await stage.setBackdrop(BACKDROP);
	await stage.open(`/${WORKSPACE}/projects/support`);
	await drawCursor(stage);
	await stage.page.waitForTimeout(1500);

	const frames = mkdtempSync(join(tmpdir(), "sugabots-capture-frames-"));
	const recording = await record(stage, frames);
	let posterSeconds = 0;
	const directing = {
		...director,
		markPoster: () => {
			posterSeconds = recording.elapsedSeconds();
		},
	};
	for (const [index, scene] of SCENES.entries()) {
		step(`Video (${chrome}): scene ${index + 1} of ${SCENES.length}`);
		await scene.play(stage, directing);
	}
	const length = recording.elapsedSeconds();
	const list = await recording.stop();
	await context.close();

	step(`Video (${chrome}): encoding`);
	mkdirSync(OUTPUT, { recursive: true });
	const video = join(OUTPUT, `${name}.mp4`);
	ffmpeg([
		"-f",
		"concat",
		"-safe",
		"0",
		"-i",
		list,
		"-vf",
		`setpts=PTS/${SPEED},fps=${FRAMES_PER_SECOND},tpad=stop_mode=clone:stop_duration=${END_HOLD_SECONDS},format=yuv420p`,
		"-c:v",
		"libx264",
		"-preset",
		"slow",
		"-crf",
		QUALITY,
		"-movflags",
		"+faststart",
		video,
	]);
	const posterAt = posterSeconds / SPEED + POSTER_OFFSET_SECONDS;
	ffmpeg([
		"-ss",
		posterAt.toFixed(2),
		"-i",
		video,
		"-frames:v",
		"1",
		"-c:v",
		"libwebp",
		"-quality",
		"90",
		join(OUTPUT, `${NAME}-poster-${chrome}.webp`),
	]);
	rmSync(frames, { recursive: true });
	console.log(
		`Wrote public/demo/${name}.mp4 (${clock(length / SPEED + END_HOLD_SECONDS)}) and its poster. Set demoVideo.duration in media.ts if it changed.`,
	);
}

/**
 * Records the stage through Chrome's screencast, which sends a frame each time
 * the page paints, and writes them with their timings for ffmpeg's concat.
 */
async function record(stage: Stage, directory: string) {
	const session = await stage.page.context().newCDPSession(stage.page);
	const frames: { file: string; timestamp: number }[] = [];
	const startedAt = Date.now();
	session.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
		const file = join(directory, `${String(frames.length).padStart(6, "0")}.jpg`);
		writeFileSync(file, Buffer.from(data, "base64"));
		frames.push({ file, timestamp: metadata.timestamp ?? Date.now() / 1000 });
		void session.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
	});
	await session.send("Page.startScreencast", {
		format: "jpeg",
		quality: JPEG_QUALITY,
		maxWidth: LAYOUT.stage.width,
		maxHeight: LAYOUT.stage.height,
	});
	return {
		elapsedSeconds: () => (Date.now() - startedAt) / 1000,
		async stop() {
			await session.send("Page.stopScreencast");
			await session.detach();
			const lines = frames.flatMap((frame, index) => {
				const next = frames[index + 1];
				const duration = next ? next.timestamp - frame.timestamp : 1 / FRAMES_PER_SECOND;
				return [`file '${frame.file}'`, `duration ${duration.toFixed(4)}`];
			});
			// The concat demuxer ignores the last duration unless the last file is listed again.
			const last = frames.at(-1);
			if (last) lines.push(`file '${last.file}'`);
			const list = join(directory, "frames.txt");
			writeFileSync(list, `${lines.join("\n")}\n`);
			return list;
		},
	};
}

/** `m:ss`, as `media.ts` shows the video's length. */
function clock(seconds: number) {
	const whole = Math.round(seconds);
	return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function ffmpeg(args: string[]) {
	execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...args], { stdio: "inherit" });
}

type Director = ReturnType<typeof directorFor>;

/** The id a `/chats/:id/messages` or `/projects/:id/chats` request names. */
function addressedIdOf(url: string) {
	return new URL(url).pathname.split("/").at(-2) ?? "";
}

/**
 * The bot whose default project a `/projects/:id/chats` request starts a
 * chat in, read from the workspace's bots as the signed-in page would: the
 * stage starts a bot's chat by its bot.
 */
async function botOfDefaultProject(context: BrowserContext, url: string): Promise<string> {
	const projectId = addressedIdOf(url);
	const answer = await context.request.get(
		new URL(`/api/workspaces/${WORKSPACE}/bots`, url).toString(),
	);
	const bots = (await answer.json()) as Array<{ id: string; defaultProjectId: string }>;
	const bot = bots.find((one) => one.defaultProjectId === projectId);
	if (!bot) throw new Error(`No bot has the default project ${projectId}`);
	return bot.id;
}

/**
 * Answers the page's send once the stage's own event, which reaches it through
 * Postgres and the server, has landed: the page drops its copy of the message
 * when this answers, so answering first makes the message vanish for a frame.
 */
async function answerAfterEvent(route: Route, body: string) {
	await new Promise((resolve) => setTimeout(resolve, EVENT_LEAD_MILLISECONDS));
	await route.fulfill({ status: 201, contentType: "application/json", body });
}

/** Runs the showcase stage against the capture's database, and answers the app's writes with it. */
function directorFor(environment: Environment) {
	/** Runs a stage command, resolving with the first line it prints, and leaves it to finish. */
	const stage = (args: string[]): Promise<string> =>
		new Promise((resolve, reject) => {
			const child = spawn("node", ["packages/demo/src/showcase/stage.ts", ...args], {
				cwd: REPO,
				env: environment.env,
			});
			let out = "";
			let errors = "";
			let answered = false;
			child.stdout.on("data", (chunk) => {
				out += chunk;
				const line = out.indexOf("\n");
				if (answered || line < 0) return;
				answered = true;
				resolve(out.slice(0, line));
			});
			child.stderr.on("data", (chunk) => {
				errors += chunk;
			});
			child.on("exit", (code) => {
				if (code) console.error(`The stage's ${args[0]} failed: ${errors}`);
				if (answered) return;
				if (code) reject(new Error(errors));
				else resolve(out.trim());
			});
		});

	return {
		stage,
		/**
		 * Anita's messages are posted by the stage, which plays what follows: a
		 * chat she starts with a bot, or writes in, the bot's part in it; one in a
		 * project's chat, whoever answers her. Allow is answered here, and the
		 * stage plays the rest.
		 */
		async answerFor(context: BrowserContext) {
			await context.route("**/api/projects/*/chats", async (route) => {
				const request = route.request();
				if (request.method() !== "POST") return route.continue();
				const sent = request.postDataJSON() as { id: string; message: string };
				const botId = await botOfDefaultProject(context, request.url());
				const started = await stage(["start", botId, sent.id, sent.message]);
				await answerAfterEvent(route, started);
			});
			await context.route("**/api/chats/*/messages", async (route) => {
				const request = route.request();
				if (request.method() !== "POST") return route.continue();
				const sent = request.postDataJSON() as { id: string; message: string };
				const chatId = addressedIdOf(request.url());
				const posted = await stage(["send", chatId, sent.id, sent.message]);
				await answerAfterEvent(route, posted);
			});
			await context.route("**/tool-calls/*/approval", async (route) => {
				const toolCallId = new URL(route.request().url()).pathname.split("/").at(-2) ?? "";
				void stage(["allow", toolCallId]);
				await route.fulfill({ status: 202, body: "" });
			});
		},
	};
}
