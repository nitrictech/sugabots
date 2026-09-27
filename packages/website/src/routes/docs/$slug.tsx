import { createFileRoute, notFound } from "@tanstack/react-router";
import { cn } from "cn";
import { motion } from "motion/react";
import { accentText } from "@/components/accent";
import { BotAvatar } from "@/components/bot-avatar";
import { Reveal, RevealItem, riseIn } from "@/components/reveal";
import { CopyPageButton } from "@/docs/components/copy-page-button";
import { DocsSidebar } from "@/docs/components/docs-nav";
import { docsComponents } from "@/docs/components/mdx-components";
import { OnThisPage } from "@/docs/components/on-this-page";
import { PageLinks } from "@/docs/components/page-links";
import { findDocPage, neighbours } from "@/docs/pages";
import { siteMeta } from "@/site-meta";

export const Route = createFileRoute("/docs/$slug")({
	loader: ({ params }) => {
		const page = findDocPage(params.slug);
		if (!page) throw notFound();
		return { title: page.title, description: page.description };
	},
	head: ({ loaderData }) => ({
		meta: loaderData && [
			{ title: `${loaderData.title} | Sugabots docs` },
			{ name: "description", content: loaderData.description },
			{ property: "og:title", content: `${loaderData.title} | Sugabots docs` },
			{ property: "og:description", content: loaderData.description },
			{ property: "og:url", content: `${siteMeta.url}/docs` },
		],
	}),
	component: DocsPage,
});

function DocsPage() {
	const { slug } = Route.useParams();
	// The loader has already turned an unknown slug away.
	const page = findDocPage(slug);
	if (!page) return null;
	const { Content } = page;

	return (
		<div className="mx-auto flex max-w-7xl gap-10 px-6">
			<DocsSidebar />
			<main className="docs-content min-w-0 flex-1 py-10 lg:py-14">
				<article className="mx-auto max-w-3xl">
					{/* Keyed so each page's header plays in as it arrives. */}
					<Reveal key={slug} className="flex flex-col gap-5 pb-4">
						<RevealItem variant="pop" className="w-fit">
							<BotAvatar size="lg" {...page.bot} className="size-14 rotate-[-6deg]" />
						</RevealItem>
						<motion.p
							variants={riseIn}
							className={cn(
								"flex items-center gap-2 text-sm font-semibold",
								accentText({ tone: page.group.tone }),
							)}
						>
							<span className="size-2 rounded-full bg-current" />
							{page.group.title}
						</motion.p>
						<motion.h1
							variants={riseIn}
							className="text-4xl font-black tracking-tight text-balance sm:text-5xl"
						>
							{page.title}
						</motion.h1>
						<motion.p variants={riseIn} className="text-lg text-muted-foreground text-pretty">
							{page.description}
						</motion.p>
						<RevealItem>
							<CopyPageButton markdown={page.markdown} />
						</RevealItem>
					</Reveal>
					<Content components={docsComponents} />
					<PageLinks {...neighbours(page)} />
				</article>
			</main>
			<OnThisPage headings={page.headings} />
		</div>
	);
}
