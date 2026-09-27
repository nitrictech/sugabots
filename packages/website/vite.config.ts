import mdx from "@mdx-js/rollup";
import rehypeShiki from "@shikijs/rehype";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import rehypeSlug from "rehype-slug";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdxFrontmatter from "remark-mdx-frontmatter";
import type { ShikiTransformer } from "shiki";
import { defineConfig, type Plugin } from "vite";

/** Puts a code block's language, and any `title="…"` from its fence, on its `<pre>` for the docs' code frame. */
const codeBlockLabels: ShikiTransformer = {
	pre(node) {
		node.properties["data-language"] = this.options.lang;
		const title = /title="([^"]*)"/.exec(this.options.meta?.__raw ?? "")?.[1];
		if (title) node.properties["data-title"] = title;
	},
};

/**
 * Docs pages are MDX, compiled to JSX before the React plugin sees them. The
 * MDX plugin ignores a module's query, so `?raw` imports, which the docs use to
 * read their own source for "Copy as Markdown", are passed over here.
 */
function docsMdx(): Plugin {
	const compileMdx = mdx({
		remarkPlugins: [remarkGfm, remarkFrontmatter, remarkMdxFrontmatter],
		rehypePlugins: [
			rehypeSlug,
			[
				rehypeShiki,
				{
					// Both themes are emitted as CSS variables; styles.css picks one per colour scheme.
					themes: { light: "github-light", dark: "github-dark" },
					defaultColor: false,
					transformers: [codeBlockLabels],
				},
			],
		],
	});
	return {
		...compileMdx,
		name: "docs-mdx",
		enforce: "pre",
		transform(code, id) {
			if (id.includes("?raw")) return;
			return compileMdx.transform?.call(this, code, id);
		},
	};
}

export default defineConfig({
	resolve: { tsconfigPaths: true },
	server: {
		// Portless passes both; see packages/web/vite.config.ts for why $HOST matters.
		port: Number(process.env.PORT) || 3000,
		host: process.env.HOST || "localhost",
	},
	plugins: [
		tailwindcss(),
		docsMdx(),
		// Every page is rendered to static HTML at build time, found by following links from the
		// pages listed. The docs are listed because the landing page hides its link until launch.
		tanstackStart({
			pages: [{ path: "/" }, { path: "/docs" }],
			prerender: { enabled: true, crawlLinks: true, failOnError: true },
		}),
		react(),
	],
});
