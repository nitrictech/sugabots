/**
 * Makes the landing page's screenshots and demo video from the app itself:
 * a throwaway Sugabots seeded with the showcase, driven in a browser, framed
 * on the site's gradient. Needs Docker and ffmpeg.
 *
 *   bun run capture                 everything
 *   bun run capture screenshots     only the carousel's slides
 *   bun run capture video           only the demo video
 */

import { launch } from "./browser.ts";
import { start } from "./environment.ts";
import { captureScreenshots } from "./screenshots.ts";
import { captureVideo } from "./video.ts";

const WHAT = ["screenshots", "video"] as const;
const asked = process.argv.slice(2);
const unknown = asked.filter((what) => !(WHAT as readonly string[]).includes(what));
if (unknown.length > 0) {
	console.error(
		`Unknown: ${unknown.join(", ")}. Choose from ${WHAT.join(", ")}, or none for both.`,
	);
	process.exit(1);
}
const wanted = (what: (typeof WHAT)[number]) => asked.length === 0 || asked.includes(what);

const environment = await start();
const browser = await launch();
try {
	if (wanted("screenshots")) await captureScreenshots(browser, environment);
	if (wanted("video")) await captureVideo(browser, environment);
} finally {
	await browser.close();
	await environment.stop();
}
