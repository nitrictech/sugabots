/**
 * Tells search engines which pages a deploy changed, through IndexNow.
 * .github/workflows/indexnow.yml runs it once Workers Builds has deployed
 * sugabots.ai, with the commits the deploy brought in:
 *
 *   bun scripts/submit-indexnow.ts --base <main before the push> --head <deployed commit>
 *
 * IndexNow asks to be sent only pages whose content changed. A changed docs
 * page is sent alone; a change to the website's source sends the few pages it
 * writes. `--all` sends every page, for the first submission or after one
 * failed. `--dry-run` prints the URLs without sending them.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parseArgs, promisify } from "node:util";
import { pageUrl, siteMeta } from "../src/site-meta.ts";
import { sitePagePaths } from "../src/site-pages.ts";

/**
 * IndexNow checks that we own the site by fetching `/<key>.txt` and comparing
 * it with the key we send, so the key is public.
 */
const INDEXNOW_KEY = "7ccc24687249488083bad2bcac7be8b6";
const KEY_FILE = new URL(`../public/${INDEXNOW_KEY}.txt`, import.meta.url);

/** Any IndexNow endpoint shares what it's sent with every participating engine; this one is IndexNow's own. */
const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

const SUBMIT_TIMEOUT_MS = 10_000;

const execFileAsync = promisify(execFile);

/** One MDX file per docs page, published at `/docs/<file name>` by src/docs/pages.ts. */
const DOCS_CONTENT = "packages/docs/content/";
const DOCS_PAGE_PREFIX = "/docs/";
/** Writes every page that isn't a docs page, and the layout all pages share. */
const WEBSITE_SOURCE = "packages/website/src/";

const TEST_FILE = /\.test\.[^/]+$/;

/**
 * Each page that isn't a docs page, such as the home page and the docs home.
 * They're sent whenever the website's source changes, even if only the layout
 * did, since telling which source files say what's on them isn't worth it.
 */
const sourcePagePaths = sitePagePaths.filter((path) => !path.startsWith(DOCS_PAGE_PREFIX));

interface FileChange {
	path: string;
	deleted: boolean;
}

async function changedFiles(base: string, head: string): Promise<FileChange[]> {
	const { stdout } = await execFileAsync("git", [
		"diff",
		"--name-status",
		"--no-renames",
		base,
		head,
		"--",
		// `:(top)` resolves the paths from the repository root, wherever this runs from.
		`:(top)${DOCS_CONTENT}`,
		`:(top)${WEBSITE_SOURCE}`,
	]);
	return stdout
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => {
			const [status, path = ""] = line.split("\t");
			return { path, deleted: status === "D" };
		});
}

function changedPages(changes: readonly FileChange[]): string[] {
	const sourceChanged = changes.some(
		({ path }) => path.startsWith(WEBSITE_SOURCE) && !TEST_FILE.test(path),
	);
	const pages = [
		...(sourceChanged ? sourcePagePaths : []),
		...changes.flatMap((change) => docsPageChangedBy(change) ?? []),
	];
	return [...new Set(pages)];
}

/**
 * The docs page a file holds. The build fails unless nav.ts lists every docs
 * file, so a deleted file is a page that was published and is now gone.
 */
function docsPageChangedBy({ path, deleted }: FileChange) {
	if (!path.startsWith(DOCS_CONTENT)) return undefined;
	const slug = path.slice(DOCS_CONTENT.length).match(/^([^/]+)\.mdx$/)?.[1];
	if (slug === undefined) return undefined;
	const page = `${DOCS_PAGE_PREFIX}${slug}`;
	if (!deleted && !sitePagePaths.includes(page)) {
		throw new Error(
			`${path} changed, but the site has no ${page}: update DOCS_CONTENT and DOCS_PAGE_PREFIX to match src/docs/pages.ts.`,
		);
	}
	return page;
}

/**
 * IndexNow accepts a submission before it checks the key file, so a key that
 * doesn't match would otherwise fail without anyone seeing.
 */
async function assertKeyFileMatches() {
	const contents = await readFile(KEY_FILE, "utf8").catch(() => undefined);
	if (contents?.trim() !== INDEXNOW_KEY) {
		throw new Error(`public/${INDEXNOW_KEY}.txt must exist and contain only the key.`);
	}
}

async function submit(urls: readonly string[]) {
	const response = await fetch(INDEXNOW_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json; charset=utf-8" },
		body: JSON.stringify({ host: new URL(siteMeta.url).host, key: INDEXNOW_KEY, urlList: urls }),
		signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
	});
	// 202 means accepted while IndexNow is still checking the key file.
	if (!response.ok) {
		throw new Error(`IndexNow rejected the URLs: ${response.status} ${await response.text()}`);
	}
}

async function pagesToSubmit(options: { base?: string; head?: string; all: boolean }) {
	if (options.all) {
		if (options.base !== undefined || options.head !== undefined) {
			throw new Error("--all sends every page, so it takes no --base or --head.");
		}
		return sitePagePaths;
	}
	if (options.base === undefined || options.head === undefined) {
		throw new Error("Pass --base and --head commits, or --all for every page.");
	}
	return changedPages(await changedFiles(options.base, options.head));
}

const { values: options } = parseArgs({
	options: {
		base: { type: "string" },
		head: { type: "string" },
		all: { type: "boolean", default: false },
		"dry-run": { type: "boolean", default: false },
	},
});

await assertKeyFileMatches();
const urls = (await pagesToSubmit(options)).map(pageUrl);
if (urls.length === 0) {
	console.log("No page's content changed.");
} else if (options["dry-run"]) {
	console.log(urls.join("\n"));
} else {
	await submit(urls);
	console.log(`Submitted ${urls.length} pages:\n${urls.join("\n")}`);
}
