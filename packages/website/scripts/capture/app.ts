import type { Locator } from "playwright";
import { WORKSPACE } from "./browser.ts";
import type { Stage } from "./stage.ts";

/**
 * Moving around the app as a person would, for the video: a drawn cursor that
 * glides to what it clicks, and typing at a typing pace. Playwright's own
 * clicks don't draw a cursor, so the stage draws one over the window.
 */

const wait = (stage: Stage, milliseconds: number) => stage.page.waitForTimeout(milliseconds);

/**
 * A macOS-style arrow drawn on the stage, which pulses on click. The mouse's
 * own events go to the app's frame once it's over the window, so the cursor
 * is placed by `glideTo` as it moves the mouse, not by listening.
 */
export async function drawCursor(stage: Stage) {
	await stage.page.evaluate(() => {
		const cursor = document.createElement("div");
		cursor.id = "cursor";
		cursor.innerHTML =
			'<svg width="22" height="26" viewBox="0 0 22 26"><path d="M2 1.5v19.2l4.9-4.6 3.2 7.4 3.3-1.4-3.2-7.3h6.8z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
		Object.assign(cursor.style, {
			position: "fixed",
			left: "0",
			top: "0",
			zIndex: "2",
			pointerEvents: "none",
			transform: "translate(-100px,-100px)",
			filter: "drop-shadow(0 2px 3px rgba(0,0,0,.35))",
		});
		const ring = document.createElement("div");
		ring.id = "cursor-ring";
		Object.assign(ring.style, {
			position: "fixed",
			width: "34px",
			height: "34px",
			marginLeft: "-17px",
			marginTop: "-17px",
			borderRadius: "50%",
			border: "2px solid rgba(255,255,255,.85)",
			zIndex: "1",
			pointerEvents: "none",
			opacity: "0",
			transition: "opacity 120ms, transform 320ms",
		});
		document.body.append(ring, cursor);
	});
}

function placeCursor(stage: Stage, point: { x: number; y: number }) {
	return stage.page.evaluate(({ x, y }) => {
		const cursor = document.getElementById("cursor");
		if (cursor) cursor.style.transform = `translate(${x}px,${y}px)`;
	}, point);
}

function pulseCursor(stage: Stage, point: { x: number; y: number }) {
	return stage.page.evaluate(({ x, y }) => {
		const ring = document.getElementById("cursor-ring");
		if (!ring) return;
		Object.assign(ring.style, {
			left: `${x}px`,
			top: `${y}px`,
			opacity: "1",
			transform: "scale(.6)",
		});
		requestAnimationFrame(() => {
			ring.style.transform = "scale(1.2)";
		});
		setTimeout(() => {
			ring.style.opacity = "0";
		}, 260);
	}, point);
}

const mice = new WeakMap<Stage, { x: number; y: number }>();

/** Glides the mouse to the middle of `locator`, eased, and rests a moment there. */
async function glideTo(stage: Stage, locator: Locator) {
	await locator.scrollIntoViewIfNeeded();
	const box = await locator.boundingBox();
	if (!box) throw new Error("Nothing to point at");
	const viewport = stage.page.viewportSize() ?? { width: 0, height: 0 };
	const from = mice.get(stage) ?? { x: viewport.width / 2, y: viewport.height * 0.7 };
	const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	const steps = Math.max(12, Math.round(Math.hypot(to.x - from.x, to.y - from.y) / 14));
	for (let step = 1; step <= steps; step++) {
		const t = step / steps;
		const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
		const point = { x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased };
		await stage.page.mouse.move(point.x, point.y);
		await placeCursor(stage, point);
		await wait(stage, 10);
	}
	mice.set(stage, to);
	await wait(stage, 120);
}

export async function click(stage: Stage, locator: Locator) {
	await glideTo(stage, locator);
	const point = mice.get(stage);
	if (point) await pulseCursor(stage, point);
	await stage.page.mouse.down();
	await wait(stage, 90);
	await stage.page.mouse.up();
}

/** How a bot is addressed in the app's paths: `Growth Desk` is `growth-desk`. */
const handleOf = (name: string) => name.toLowerCase().replaceAll(" ", "-");

/**
 * The chat with `bot`: through the pod's rail tile, unless it's open already,
 * then the bot in the pod's list, unless the pod opened on it.
 */
export async function openChat(stage: Stage, pod: string, bot: string) {
	const podPath = `/${WORKSPACE}/pods/${handleOf(pod)}/`;
	const chatPath = `${podPath}agents/${handleOf(bot)}`;
	if (stage.app.url().endsWith(chatPath)) return;
	if (!stage.app.url().includes(podPath)) {
		await click(stage, stage.app.getByRole("link", { name: new RegExp(`^${pod}`) }).first());
		await wait(stage, 600);
	}
	if (!stage.app.url().endsWith(chatPath)) {
		await click(stage, stage.app.getByRole("link", { name: bot, exact: true }).first());
		await wait(stage, 800);
	}
}

/** Closes the panel open over the chat, as its close button does. */
export async function closePanel(stage: Stage) {
	const close = stage.app.getByRole("button", { name: /^close/i }).last();
	if (await close.isVisible().catch(() => false)) await click(stage, close);
	else await stage.page.keyboard.press("Escape");
	await wait(stage, 800);
}

/** Brisk, so the typing doesn't hold up the cut, and uneven, so it reads as a person's. */
const TYPING_MILLISECONDS = { least: 14, spread: 26 };
/** How far the camera moves in on the composer while a message is typed. */
const TYPING_ZOOM = 1.5;

/**
 * Types into the chat's composer at a typing pace and sends it, with the
 * camera in on the composer meanwhile; `toPeople` switches to people only first.
 */
export async function write(stage: Stage, text: string, { toPeople = false } = {}) {
	const composer = stage.app.getByRole("textbox", { name: /^Message/ }).first();
	await click(stage, composer);
	await stage.zoomTo(composer, TYPING_ZOOM);
	if (toPeople) {
		await stage.page.keyboard.press("Tab");
		await wait(stage, 500);
	}
	for (const character of text) {
		await stage.page.keyboard.type(character);
		await wait(stage, TYPING_MILLISECONDS.least + Math.random() * TYPING_MILLISECONDS.spread);
	}
	await wait(stage, 300);
	await stage.page.keyboard.press("Enter");
	await wait(stage, 500);
	await stage.zoomOut();
}
