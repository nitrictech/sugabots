import type { BrowserContext, Frame, Locator, Page } from "playwright";
import { type Backdrop, backdropSvg } from "./backdrops.ts";

/**
 * The frame every capture is taken in: a page of the app's own origin with a
 * picture behind it and the app in a rounded window over it. Screenshots and
 * the video share it, so restyling the framing is a change here alone.
 *
 * The window holds the app in an iframe, scaled to fit. The video's zooms are
 * a camera over the whole scene, moved with CSS, so the browser draws the app
 * sharp at every zoom and nothing is scaled up afterwards.
 */

export interface StageLayout {
	/** The stage's size, in CSS pixels: the capture is this at `deviceScaleFactor`. */
	stage: { width: number; height: number };
	/** The app's own viewport inside the window, in CSS pixels. */
	app: { width: number; height: number };
	/** How wide the window is, as a share of the stage's width. */
	windowWidth: number;
}

/** The window's title bar: as each system draws one, so a visitor sees their own. */
export type Chrome = "mac" | "windows" | "linux";
export const chromes: readonly Chrome[] = ["mac", "windows", "linux"];

/** How tall the title bar is, in the app's own pixels. */
const TITLE_BAR_PX = 38;

const STAGE_PATH = "/__capture-stage";
const BACKDROPS_PATH = "/__capture-backdrops";
const CAMERA_MILLISECONDS = 900;

export interface Stage {
	page: Page;
	/** The app, inside the window. */
	app: Frame;
	/** Draws the window's title bar as `chrome`'s system does. */
	setChrome(chrome: Chrome): Promise<void>;
	/** Puts `backdrop` behind the window, once it has loaded. */
	setBackdrop(backdrop: Backdrop): Promise<void>;
	/** Opens `path` of the app in the window and waits for it to settle. */
	open(path: string): Promise<void>;
	/** Moves the camera to fill the stage with `locator`'s area of the app, at most `scale` in. */
	zoomTo(locator: Locator, scale: number): Promise<void>;
	/** Moves the camera back to the whole scene. */
	zoomOut(): Promise<void>;
}

export async function openStage(
	context: BrowserContext,
	appUrl: string,
	layout: StageLayout,
): Promise<Stage> {
	await context.route(`${appUrl}${STAGE_PATH}`, (route) =>
		route.fulfill({ contentType: "text/html", body: stageHtml(layout) }),
	);
	await context.route(`${appUrl}${BACKDROPS_PATH}/*`, (route) => {
		const backdrop = JSON.parse(
			decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1) ?? ""),
		) as Backdrop;
		return route.fulfill({ contentType: "image/svg+xml", body: backdropSvg(backdrop) });
	});
	const page = await context.newPage();
	await page.setViewportSize(layout.stage);
	await page.goto(`${appUrl}${STAGE_PATH}`);
	let camera = { scale: 1, x: 0, y: 0 };

	const app = async () => {
		const frame = await (await page.locator("iframe").elementHandle())?.contentFrame();
		if (!frame) throw new Error("The stage has no app in its window");
		return frame;
	};

	const moveCamera = async (next: typeof camera) => {
		camera = next;
		await page.evaluate(({ scale, x, y }) => {
			const element = document.getElementById("camera");
			if (element) element.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
		}, next);
		await page.waitForTimeout(CAMERA_MILLISECONDS);
	};

	const stage: Stage = {
		page,
		app: await app(),
		async setChrome(chrome) {
			await page.evaluate((html) => {
				document
					.querySelector(".bar")
					?.replaceWith(
						Object.assign(document.createElement("template"), { innerHTML: html }).content,
					);
			}, titleBarHtml[chrome]);
		},
		async setBackdrop(backdrop) {
			await page.evaluate(
				async (url) => {
					const image = new Image();
					image.src = url;
					await image.decode();
					const element = document.getElementById("backdrop");
					if (element) element.style.backgroundImage = `url("${url}")`;
				},
				`${BACKDROPS_PATH}/${encodeURIComponent(JSON.stringify(backdrop))}`,
			);
		},
		async open(path) {
			const frame = await app();
			await frame.goto(`${appUrl}${path}`);
			await frame.waitForLoadState("load");
			stage.app = frame;
		},
		async zoomTo(locator, scale) {
			const box = await locator.boundingBox();
			if (!box) throw new Error("Nothing to zoom to");
			// Playwright gives boxes on the stage, through the window's and the camera's transforms; undo the camera's.
			const unzoomed = {
				x: (box.x - camera.x) / camera.scale,
				y: (box.y - camera.y) / camera.scale,
				width: box.width / camera.scale,
				height: box.height / camera.scale,
			};
			const fit = Math.min(
				scale,
				layout.stage.width / unzoomed.width,
				layout.stage.height / unzoomed.height,
			);
			const centre = { x: unzoomed.x + unzoomed.width / 2, y: unzoomed.y + unzoomed.height / 2 };
			const clamp = (value: number, size: number) =>
				Math.min(0, Math.max(size - size * fit, value));
			await moveCamera({
				scale: fit,
				x: clamp(layout.stage.width / 2 - centre.x * fit, layout.stage.width),
				y: clamp(layout.stage.height / 2 - centre.y * fit, layout.stage.height),
			});
		},
		zoomOut: () => moveCamera({ scale: 1, x: 0, y: 0 }),
	};
	return stage;
}

/** Where the window sits on the stage, and how much the app is scaled to fill it. */
function windowPlacement({ stage, app, windowWidth }: StageLayout) {
	const width = stage.width * windowWidth;
	const scale = width / app.width;
	const height = (app.height + TITLE_BAR_PX) * scale;
	return { x: (stage.width - width) / 2, y: (stage.height - height) / 2, width, height, scale };
}

function stageHtml(layout: StageLayout) {
	const window = windowPlacement(layout);
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
	html, body { margin: 0; width: 100%; height: 100%; overflow: clip; background: #0b0c0f; }
	#camera {
		position: absolute; inset: 0; transform-origin: 0 0;
		transition: transform ${CAMERA_MILLISECONDS}ms cubic-bezier(0.65, 0, 0.35, 1);
	}
	#backdrop {
		position: absolute; inset: 0;
		background: center / cover no-repeat;
	}
	#window {
		position: absolute;
		left: ${window.x}px; top: ${window.y}px; width: ${window.width}px; height: ${window.height}px;
		border-radius: ${Math.round(window.width / 90)}px; background: #0b0c0f;
		/* Clipped, not hidden: the unscaled iframe is larger than the window, and a hidden overflow can still be scrolled, which Playwright does to reach what it clicks. */
		overflow: clip;
		box-shadow:
			0 0 0 1px rgb(255 255 255 / 0.1),
			0 ${window.height / 40}px ${window.height / 12}px rgb(10 8 30 / 0.45),
			0 ${window.height / 12}px ${window.height / 4}px rgb(10 8 30 / 0.35);
	}
	#frame {
		width: ${layout.app.width}px; height: ${layout.app.height + TITLE_BAR_PX}px;
		transform: scale(${window.scale}); transform-origin: 0 0;
		display: flex; flex-direction: column;
	}
	iframe { width: ${layout.app.width}px; height: ${layout.app.height}px; border: 0; display: block; }
	${titleBarCss}
</style>
</head>
<body>
	<div id="camera">
		<div id="backdrop"></div>
		<div id="window"><div id="frame">${titleBarHtml.mac}<iframe src="about:blank"></iframe></div></div>
	</div>
</body>
</html>`;
}

const titleBarCss = `
	.bar {
		height: ${TITLE_BAR_PX}px; flex: none; display: flex; align-items: center;
		background: #1a1b20; border-bottom: 1px solid #26282e;
	}
	.mac { gap: 8px; padding-left: 14px; }
	.mac i { width: 12px; height: 12px; border-radius: 50%; display: block; }
	.windows { justify-content: flex-end; }
	.windows span { width: 46px; height: 100%; display: grid; place-items: center; }
	.linux { justify-content: flex-end; gap: 10px; padding-right: 10px; }
	.linux span { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; background: #2b2d34; }
	.linux span.close { background: #3a3c44; }
	svg { display: block; }
`;

const glyph = (path: string, size = 10) =>
	`<svg width="${size}" height="${size}" viewBox="0 0 10 10" fill="none" stroke="#c9ccd3" stroke-width="1">${path}</svg>`;

/** Each system's title bar: macOS's traffic lights, Windows' caption buttons, GNOME's round buttons. */
const titleBarHtml: Record<Chrome, string> = {
	mac: `<div class="bar mac"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>`,
	windows: `<div class="bar windows"><span>${glyph('<path d="M0 5.5H10"/>')}</span><span>${glyph('<rect x=".5" y=".5" width="9" height="9"/>')}</span><span>${glyph('<path d="M0 0L10 10M10 0L0 10"/>')}</span></div>`,
	linux: `<div class="bar linux"><span>${glyph('<path d="M2 5.5H8"/>', 12)}</span><span>${glyph('<rect x="2.5" y="2.5" width="5" height="5"/>', 12)}</span><span class="close">${glyph('<path d="M2.5 2.5L7.5 7.5M7.5 2.5L2.5 7.5"/>', 12)}</span></div>`,
};
