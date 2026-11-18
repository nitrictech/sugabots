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
	/** The picture behind the window: a form and grey its neighbouring slides don't share. */
	backdrop: Backdrop;
	/** Opens the app on what the slide shows. */
	prepare(stage: Stage): Promise<void>;
}

/** The carousel's slides, but for Computers, which needs a desktop: see {@link COMPUTERS}. */
const SHOTS: Shot[] = [
	{
		name: "main-chat",
		backdrop: { form: "swoop", family: "silver" },
		async prepare(stage) {
			// Growth's main chat, where its people talk with each other and with its bots.
			await openMainChat(stage, "growth");
			await stage.app.getByText("Brightwater signed!").waitFor();
		},
	},
	{
		name: "automations",
		backdrop: { form: "rings", family: "graphite" },
		async prepare(stage) {
			// Ticket Desk's automations page, with its morning queue's feed open beside the list.
			await stage.open(`/${WORKSPACE}/bots/ticket-desk/automations`);
			await stage.app
				.getByRole("region", { name: "Automations" })
				.getByRole("link", { name: /^Morning queue/ })
				.first()
				.click();
			await stage.app.getByText("Morning queue: 7 new tickets overnight.").last().waitFor();
		},
	},
	{
		name: "files",
		backdrop: { form: "sur", family: "ink" },
		async prepare(stage) {
			await openSeededTask(stage, "researcher", "What changed in Postgres 18");
			await stage.app.getByRole("button", { name: "Preview" }).last().click();
			await stage.app.waitForTimeout(600);
			await scrollToTop(stage.app.getByText("Graphile Worker fits best").last());
		},
	},
	{
		name: "usage",
		backdrop: { form: "wave", family: "silver" },
		async prepare(stage) {
			await stage.open(`/${WORKSPACE}/settings/usage`);
			await stage.app.getByText("Growth Desk").first().waitFor();
		},
	},
	{
		name: "mcp-connections",
		backdrop: { form: "petals", family: "graphite" },
		async prepare(stage) {
			// Code Reviewer's connections, then Linear's tools one by one: those that change things ask first.
			await stage.open(`/${WORKSPACE}/settings/bots/code-reviewer/connections`);
			await stage.app.getByRole("link", { name: /^Linear, / }).click();
			await stage.app.getByRole("button", { name: /^Individual tools/ }).click();
			await stage.app.getByText("prepare_attachment_upload", { exact: true }).waitFor();
		},
	},
];

/**
 * Researcher's desktop, open beside its task: the computer's button is on a
 * task's header, and Code Reviewer, whose review is in Engineering's main
 * chat, has no task. Taken in a context of its own: showing the desktop says
 * computers are on, which puts the desktop's button on every task with a bot
 * that uses one.
 */
const COMPUTERS: Shot = {
	name: "computers",
	backdrop: { form: "petals", family: "ink" },
	async prepare(stage) {
		await openSeededTask(stage, "researcher", "What changed in Postgres 18");
		await stage.app.getByRole("button", { name: "Computer" }).click();
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

	step("Starting a computer desktop");
	const desktop = await startDesktop();
	if (desktop) {
		// A context of its own, where computers are on from the start.
		const computerContext = await signedInContext(browser, environment, SCALE);
		try {
			await desktop.showIn(computerContext);
			await take(await openStage(computerContext, environment.appUrl, LAYOUT), COMPUTERS, work);
		} finally {
			await computerContext.close();
			desktop.stop();
		}
	}
	rmSync(work, { recursive: true });
}

/** Takes `shot` once for each system's title bar: `main-chat-mac.webp`, `main-chat-windows.webp` and so on. */
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

/** The channel's main chat, General, which the channel's own address opens. */
async function openMainChat(stage: Stage, channel: string) {
	await stage.open(`/${WORKSPACE}/channels/${channel}`);
	await stage.app.getByRole("heading", { name: "General" }).first().waitFor();
}

/**
 * Opens the seeded task whose title starts `title`: the bot's own address
 * opens its newest open task, which is the bot's only one in the seed. A long
 * title is cut short, so the start is what to match.
 */
async function openSeededTask(stage: Stage, botHandle: string, title: string) {
	await stage.open(`/${WORKSPACE}/bots/${botHandle}`);
	await stage.app
		.getByRole("heading", { name: new RegExp(`^${escapeRegExp(title)}`) })
		.first()
		.waitFor();
}

function escapeRegExp(text: string) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
