import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext } from "playwright";
import { click, closePanel, drawCursor, openChat, write } from "./app.ts";
import type { Backdrop } from "./backdrops.ts";
import { signedInContext, WORKSPACE } from "./browser.ts";
import { type Environment, REPO, step } from "./environment.ts";
import { type Chrome, chromes, openStage, type Stage } from "./stage.ts";

/**
 * The demo under the hero. Kestrel Freight was charged twice: Anita asks
 * Ticket Desk to refund it and Code Reviewer why, moving between the chats
 * while the bots work, as their badges come in.
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
const SPEED = 1.6;
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
	refund: "Kestrel Freight was charged twice on 3 Oct. Can you refund the duplicate?",
	cause: "Why did Kestrel get charged twice? Can you dig into it?",
	reassure: "It won't. Code Reviewer found the cause and Gary's reviewing the fix.",
};

interface Scene {
	/** What the scene shows, for whoever edits the story. */
	about: string;
	play(stage: Stage, director: Director): Promise<void>;
}

// The cursor only ever goes to what it clicks: there is no time in the cut for it to wander.
const SCENES: Scene[] = [
	{
		about: "Anita asks Ticket Desk to refund Kestrel Freight's duplicate charge.",
		async play(stage) {
			await openChat(stage, "Support", "Ticket Desk");
			await write(stage, SAYS.refund);
			await stage.page.waitForTimeout(1800);
		},
	},
	{
		about: "Without waiting, she asks Code Reviewer why it happened.",
		async play(stage) {
			await openChat(stage, "Engineering", "Code Reviewer");
			await write(stage, SAYS.cause);
			await stage.page.waitForTimeout(1800);
		},
	},
	{
		about:
			"Ticket Desk asks before it refunds. Anita finds it in Approvals, allows it in the chat, and Lorraine thanks it.",
		async play(stage) {
			const approvals = stage.app.getByRole("link", { name: /^Approvals, \d+ waiting/ });
			await approvals.waitFor({ timeout: 20_000 });
			await stage.page.waitForTimeout(600);
			await click(stage, approvals);
			await stage.page.waitForTimeout(800);
			await click(stage, stage.app.getByRole("link").filter({ hasText: "Create refund" }).first());
			await stage.page.waitForTimeout(1600);
			await click(stage, stage.app.getByRole("link", { name: "Open in Ticket Desk" }));
			const allow = stage.app.getByRole("button", { name: /^Allow:/ }).first();
			await allow.waitFor({ timeout: 20_000 });
			await stage.page.waitForTimeout(600);
			await click(stage, allow);
			await stage.app.getByText("I'll let Kestrel know").first().waitFor({ timeout: 20_000 });
			await stage.page.waitForTimeout(1000);
		},
	},
	{
		about: "Code Reviewer found the cause with Researcher and wrote it up. Gary takes the fix.",
		async play(stage, director) {
			await openChat(stage, "Engineering", "Code Reviewer");
			await stage.app.getByText("Found it.").first().waitFor({ timeout: 25_000 });
			await stage.page.waitForTimeout(1200);
			await click(stage, stage.app.getByRole("button", { name: /Open Collaboration/ }).last());
			await stage.page.waitForTimeout(2600);
			await closePanel(stage);
			await click(stage, stage.app.getByRole("button", { name: /^Open Incident/ }).last());
			await stage.page.waitForTimeout(3000);
			await closePanel(stage);
			// Gary answers now, so his typing shows in the chat Anita is looking at.
			void director.stage(["cue", "review"]);
			await stage.app.getByText("I'll review #491").first().waitFor({ timeout: 20_000 });
			await stage.page.waitForTimeout(1200);
		},
	},
	{
		about:
			"Lorraine mentions Anita in Support. She sees it in Activity and answers, and Lorraine closes the ticket.",
		async play(stage, director) {
			void director.stage(["cue", "mention"]);
			const activity = stage.app.getByRole("link", { name: /^Activity, \d+ unread mention/ });
			await activity.waitFor({ timeout: 20_000 });
			await stage.page.waitForTimeout(800);
			await click(stage, activity);
			await stage.page.waitForTimeout(800);
			await click(stage, stage.app.getByRole("link").filter({ hasText: "mentioned you" }).first());
			await stage.page.waitForTimeout(1200);
			await write(stage, SAYS.reassure, { toPeople: true });
			await stage.app.getByText("I've closed the ticket").first().waitFor({ timeout: 20_000 });
			await stage.page.waitForTimeout(2000);
		},
	},
];

/** The scene the poster is taken from: Anita going to Approvals. */
const POSTER_SCENE = 2;
/** How far into it, in the finished video's seconds. */
const POSTER_OFFSET_SECONDS = 1.2;

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
	await stage.open(`/${WORKSPACE}/pods/support/agents/ticket-desk`);
	await drawCursor(stage);
	await stage.page.waitForTimeout(1500);

	const frames = mkdtempSync(join(tmpdir(), "sugabots-capture-frames-"));
	const recording = await record(stage, frames);
	const starts: number[] = [];
	for (const [index, scene] of SCENES.entries()) {
		step(`Video (${chrome}): scene ${index + 1} of ${SCENES.length}`);
		starts.push(recording.elapsedSeconds());
		await scene.play(stage, director);
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
	const posterAt = (starts[POSTER_SCENE] ?? 0) / SPEED + POSTER_OFFSET_SECONDS;
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
		 * Anita's messages are posted by the stage, which plays what follows: the
		 * bot's part, or for one to the people only, whoever answers her. Allow
		 * is answered here, and the stage plays the rest.
		 */
		async answerFor(context: BrowserContext) {
			await context.route("**/api/chats/*/messages", async (route) => {
				const request = route.request();
				if (request.method() !== "POST") return route.continue();
				const sent = request.postDataJSON() as {
					id: string;
					message: string;
					peopleOnly?: boolean;
				};
				const chatId = new URL(request.url()).pathname.split("/").at(-2) ?? "";
				const audience = sent.peopleOnly ? "people" : "bot";
				const posted = await stage(["send", chatId, sent.id, audience, sent.message]);
				// The page drops its own copy of the message when this answers, so the
				// stage's event, which reaches it through Postgres and the server, must
				// land first, or the message vanishes for a frame.
				await new Promise((resolve) => setTimeout(resolve, EVENT_LEAD_MILLISECONDS));
				await route.fulfill({ status: 201, contentType: "application/json", body: posted });
			});
			await context.route("**/tool-calls/*/approval", async (route) => {
				const toolCallId = new URL(route.request().url()).pathname.split("/").at(-2) ?? "";
				void stage(["allow", toolCallId]);
				await route.fulfill({ status: 202, body: "" });
			});
		},
	};
}
