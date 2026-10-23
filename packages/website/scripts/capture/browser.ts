import { type Browser, type BrowserContext, chromium } from "playwright";
import { type Environment, OWNER } from "./environment.ts";

/** The showcase workspace's slug, which starts every path in it. */
export const WORKSPACE = "fieldnote";

export function launch(): Promise<Browser> {
	return chromium.launch();
}

/**
 * The app opens a chat's Details beside it where there is room, unless this
 * device last closed it: as `packages/web/src/lib/details-open.ts` stores it.
 * The captures leave it closed, so the chat has the window.
 */
const DETAILS_CLOSED = `try { localStorage.setItem("sugabots-details-open", "closed"); } catch {}`;

/** A dark-mode context signed in as the showcase's owner, with chats' Details closed. */
export async function signedInContext(
	browser: Browser,
	environment: Environment,
	deviceScaleFactor: number,
): Promise<BrowserContext> {
	const context = await browser.newContext({ colorScheme: "dark", deviceScaleFactor });
	await context.addInitScript(DETAILS_CLOSED);
	const page = await context.newPage();
	await page.goto(`${environment.appUrl}/login`);
	await page.getByText("Continue with email").click();
	await page.locator('input[type="email"]').fill(OWNER.email);
	await page.locator('input[type="password"]').fill(OWNER.password);
	await page.keyboard.press("Enter");
	await page.waitForURL(new RegExp(`/${WORKSPACE}/`));
	await page.close();
	return context;
}
