import { createFileRoute } from "@tanstack/react-router";
import { pageUrl } from "@/site-meta";
import { sitePagePaths } from "@/site-pages";

/** Every page on the site, for search engines. */
function sitemapXml() {
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
		...sitePagePaths.map((path) => `\t<url><loc>${pageUrl(path)}</loc></url>`),
		"</urlset>",
		"",
	].join("\n");
}

export const Route = createFileRoute("/sitemap.xml")({
	server: {
		handlers: {
			GET: () =>
				new Response(sitemapXml(), {
					headers: { "Content-Type": "application/xml; charset=utf-8" },
				}),
		},
	},
});
