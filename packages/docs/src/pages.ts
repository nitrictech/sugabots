/**
 * The docs pages as text, read from disk, for the server to hand to its bots.
 * The website reads the same files through its build, with `./page.ts`, and
 * sets their reading order and look in its own `docs/nav.ts`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type DocPage, parseDocPage } from "./page.ts";

export type { DocHeading, DocPage, DocSection } from "./page.ts";

/** One MDX file per page, named by its slug. */
const CONTENT_DIRECTORY = join(import.meta.dirname, "../content");

/** Every docs page, by slug. */
export const docPages: readonly DocPage[] = readdirSync(CONTENT_DIRECTORY)
	.filter((name) => name.endsWith(".mdx"))
	.sort()
	.map((name) =>
		parseDocPage(
			name.slice(0, -".mdx".length),
			readFileSync(join(CONTENT_DIRECTORY, name), "utf8"),
		),
	);
