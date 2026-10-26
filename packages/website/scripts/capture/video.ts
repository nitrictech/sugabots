import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Route } from "playwright";
import { click, closePanel, drawCursor, openThread, write } from "./app.ts";
import type { Backdrop } from "./backdrops.ts";
import { signedInContext, WORKSPACE } from "./browser.ts";
import { type Environment, REPO, step } from "./environment.ts";
import { type Chrome, chromes, openStage, type Stage } from "./stage.ts";

/**
 * The demo under the hero. Kestrel Freight was charged twice: from Support's
 * chat, Anita starts a thread asking Ticket Desk to refund it. Ticket Desk
 * offers to find out why too, hands that to Billing Engineer, asks before it
 * refunds, and Support's people pick it up from there.
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
/** The sur form in the logo's four colours, the rainbow the headline's highlight uses. */
const BACKDROP: Backdrop = { form: "sur", family: "logo" };
/** The video plays this much faster than it was acted, so the bots' streaming doesn't drag. */
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

/** What Anita writes, in the order she writes it. */
const SAYS = {
	refund: "@ticket-desk Kestrel Freight was charged twice on 3 Oct. Can you refund the duplicate?",
	goAhead: "Yes please.",
	reassure: "It won't. Billing Engineer found the cause, and #491 fixes it.",
};

/** The thread Anita's first message starts, titled from it as the app titles a thread. */
const THREAD = "Kestrel Freight was charged twice on 3 Oct.";

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
			"In Support's chat, under Ticket Desk's morning queue, Anita asks Ticket Desk to refund Kestrel Freight. A thread starts from her message.",
		async play(stage) {
			await stage.page.waitForTimeout(1200);
			await write(stage, SAYS.refund);
			await openThread(stage, THREAD);
		},
	},
	{
		about:
			"Ticket Desk offers to find out why it happened too, and Anita says yes. It finds both charges in Stripe and hands the why to Billing Engineer, which Anita looks in on.",
		async play(stage) {
			await stage.app
				.getByText("Want me to ask Billing Engineer")
				.first()
				.waitFor({ timeout: 20_000 });
			await stage.page.waitForTimeout(2000);
			await write(stage, SAYS.goAhead);
			const collaboration = stage.app.getByRole("button", {
				name: /^Open Collaboration: Ticket Desk and Billing Engineer/,
			});
			await collaboration.waitFor({ timeout: 30_000 });
			await stage.page.waitForTimeout(1600);
			await click(stage, collaboration);
			await stage.app.getByText("Found it.").first().waitFor({ timeout: 30_000 });
			await stage.page.waitForTimeout(3200);
			await closePanel(stage);
		},
	},
	{
		about:
			"Ticket Desk asks before it refunds. Anita allows it there, Ticket Desk sums up, and Lorraine thanks it.",
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
			"Doreen mentions Anita in Support's chat. She sees it in Activity and answers, and Doreen closes the ticket.",
		async play(stage, director) {
			void director.stage(["cue", "mention"]);
			const activity = stage.app.getByRole("link", { name: /^Activity, \d+ unread mention/ });
			await activity.waitFor({ timeout: 20_000 });
			await stage.page.waitForTimeout(1000);
			await click(stage, activity);
			await stage.page.waitForTimeout(1000);
			await click(stage, stage.app.getByRole("link", { name: /mentioned you/ }).first());
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
	await stage.open(`/${WORKSPACE}/pods/support`);
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

/** The conversation a `/conversations/:id/...` request is to. */
function conversationIdOf(url: string) {
	return new URL(url).pathname.split("/").at(-2) ?? "";
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
		 * thread she starts with a bot, the bot's part in it; one in a pod's
		 * chat, whoever answers her. Allow is answered here, and the stage plays
		 * the rest.
		 */
		async answerFor(context: BrowserContext) {
			await context.route("**/api/conversations/*/threads", async (route) => {
				const request = route.request();
				if (request.method() !== "POST") return route.continue();
				const sent = request.postDataJSON() as {
					id: string;
					message: string;
					hostAgentId?: string;
				};
				if (!sent.hostAgentId) return route.continue();
				const podChatId = conversationIdOf(request.url());
				const started = await stage(["start", podChatId, sent.id, sent.hostAgentId, sent.message]);
				await answerAfterEvent(route, started);
			});
			await context.route("**/api/conversations/*/messages", async (route) => {
				const request = route.request();
				if (request.method() !== "POST") return route.continue();
				const sent = request.postDataJSON() as { id: string; message: string };
				const conversationId = conversationIdOf(request.url());
				const posted = await stage(["send", conversationId, sent.id, sent.message]);
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
