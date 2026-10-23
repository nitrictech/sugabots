import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Locator } from "playwright";
import type { Backdrop } from "./backdrops.ts";
import { signedInContext, WORKSPACE } from "./browser.ts";
import { startDesktop } from "./desktop.ts";
import { type Environment, REPO, step } from "./environment.ts";
import { chromes, openStage, type Stage } from "./stage.ts";

/** The carousel's slides are 16:10: this at 2× is the 2240×1400 that `media.ts` asks for. */
const LAYOUT = {
	stage: { width: 1120, height: 700 },
	/** A desktop browser's shape, wide enough to fill most of the slide, leaving the window a margin above and below. */
	app: { width: 1440, height: 944 },
	windowWidth: 0.84,
};
const SCALE = 2;
const WEBP_QUALITY = "90";
/** How far below the top of the chat `scrollToTop` leaves its message, to show the byline above it. */
const LEAD_PX = 80;
const OUTPUT = join(REPO, "packages/website/public/screenshots");

interface Shot {
	/** The file's name in `public/screenshots`, before its system and `.webp`. */
	name: string;
	/** The picture behind the window: a colour no other slide has, matching the bot it shows where it shows one. */
	backdrop: Backdrop;
	/** Opens the app on what the slide shows. */
	prepare(stage: Stage): Promise<void>;
}

/** The carousel's slides, but for Sandboxes, which needs a desktop: see {@link SANDBOXES}. */
const SHOTS: Shot[] = [
	{
		name: "one-thread",
		backdrop: { form: "swoop", family: "green" },
		async prepare(stage) {
			await stage.open(`/${WORKSPACE}/pods/growth/agents/growth-desk`);
			await stage.app.getByText("Nice. Send it").waitFor();
		},
	},
	{
		name: "routines",
		backdrop: { form: "rings", family: "purple" },
		async prepare(stage) {
			await stage.open(`/${WORKSPACE}/settings/routines`);
			// Ticket Desk's, so the slide's purple matches its bot.
			await stage.app.getByText("Morning queue").first().click();
			await stage.app.getByText("Recent runs").waitFor();
		},
	},
	{
		name: "artifacts",
		backdrop: { form: "sur", family: "blue" },
		async prepare(stage) {
			await stage.open(`/${WORKSPACE}/pods/engineering/agents/researcher`);
			await stage.app.getByRole("button", { name: "Preview" }).last().click();
			await stage.app.waitForTimeout(600);
			await scrollToTop(stage.app.getByText("Graphile Worker fits best").last());
		},
	},
	{
		name: "usage",
		backdrop: { form: "wave", family: "teal" },
		async prepare(stage) {
			await stage.open(`/${WORKSPACE}/settings/usage`);
			await stage.app.getByText("Growth Desk").first().waitFor();
		},
	},
	{
		name: "mcp-connections",
		backdrop: { form: "petals", family: "orange" },
		async prepare(stage) {
			await stage.open(`/${WORKSPACE}/settings/pods/engineering`);
			await stage.app.getByText("Linear", { exact: true }).first().click();
			// Both groups start open; the slide shows the tools that change things, which ask first.
			await stage.app.getByRole("button", { name: /^Reading, / }).click();
			await stage.app.getByRole("group", { name: "Prepare attachment upload" }).waitFor();
		},
	},
];

/**
 * Code Reviewer's desktop, open beside its chat. Taken in a context of its
 * own: showing the desktop says sandboxes are on, which puts the desktop's
 * button on every chat with a bot that uses one.
 */
const SANDBOXES: Shot = {
	name: "sandboxes",
	backdrop: { form: "petals", family: "red" },
	async prepare(stage) {
		await stage.open(`/${WORKSPACE}/pods/engineering/agents/code-reviewer`);
		await stage.app.getByRole("button", { name: "Sandbox desktop" }).click();
		await stage.app.locator("canvas").first().waitFor();
		await stage.app.getByText("Starting the desktop…").waitFor({ state: "detached" });
	},
};

/** Takes each slide in the showcase and writes it to `public/screenshots`. */
export async function captureScreenshots(browser: Browser, environment: Environment) {
	const work = mkdtempSync(join(tmpdir(), "sugabots-capture-shots-"));
	const context = await signedInContext(browser, environment, SCALE);
	const stage = await openStage(context, environment.appUrl, LAYOUT);
	for (const shot of SHOTS) await take(stage, shot, work);
	await context.close();

	step("Starting a sandbox desktop");
	const desktop = await startDesktop();
	if (desktop) {
		// A context of its own, where sandboxes are on from the start.
		const sandboxContext = await signedInContext(browser, environment, SCALE);
		try {
			await desktop.showIn(sandboxContext);
			await take(await openStage(sandboxContext, environment.appUrl, LAYOUT), SANDBOXES, work);
		} finally {
			await sandboxContext.close();
			desktop.stop();
		}
	}
	rmSync(work, { recursive: true });
}

/** Takes `shot` once for each system's title bar: `one-thread-mac.webp`, `one-thread-windows.webp` and so on. */
async function take(stage: Stage, shot: Shot, work: string) {
	step(`Screenshot: ${shot.name}`);
	await stage.setBackdrop(shot.backdrop);
	await shot.prepare(stage);
	await settle(stage);
	for (const chrome of chromes) {
		await stage.setChrome(chrome);
		const png = join(work, `${shot.name}-${chrome}.png`);
		await stage.page.screenshot({ path: png });
		execFileSync("ffmpeg", [
			"-loglevel",
			"error",
			"-y",
			"-i",
			png,
			"-c:v",
			"libwebp",
			"-quality",
			WEBP_QUALITY,
			join(OUTPUT, `${shot.name}-${chrome}.webp`),
		]);
	}
}

/** Scrolls the chat so `locator` sits near the top of it, leaving the page itself where it is. */
async function scrollToTop(locator: Locator) {
	await locator.evaluate((element, leadPx) => {
		let scroller = element.parentElement;
		while (scroller && getComputedStyle(scroller).overflowY !== "auto")
			scroller = scroller.parentElement;
		if (!scroller) return;
		const above = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
		scroller.scrollTop += above - leadPx;
	}, LEAD_PX);
}

/** Lets images, fonts and entrance animations finish before the shutter. The app's event streams never go quiet, so there is no network idle to wait for. */
async function settle(stage: Stage) {
	await stage.app.evaluate(async () => {
		await document.fonts.ready;
		await Promise.all([...document.images].map((image) => image.decode().catch(() => undefined)));
	});
	await stage.page.waitForTimeout(800);
}
