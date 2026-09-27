import { createFileRoute, Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ArrowRightIcon } from "lucide-react";
import { motion } from "motion/react";
import { accentText } from "@/components/accent";
import { BotAvatar } from "@/components/bot-avatar";
import { BotCrowd } from "@/components/bot-crowd";
import { Emphasis } from "@/components/emphasis";
import { Reveal, RevealItem, riseIn } from "@/components/reveal";
import { SiteFooter } from "@/components/site-footer";
import { buttonVariants } from "@/components/ui/button";
import { type DocGroup, docGroups } from "@/docs/nav";
import { docPages, findDocPage } from "@/docs/pages";

const DOCS_TITLE = "Sugabots docs";
const DOCS_DESCRIPTION =
	"How Sugabots works: pods, agents, tools and models, and how to run it yourself.";

export const Route = createFileRoute("/docs/")({
	head: () => ({
		meta: [
			{ title: DOCS_TITLE },
			{ name: "description", content: DOCS_DESCRIPTION },
			{ property: "og:title", content: DOCS_TITLE },
			{ property: "og:description", content: DOCS_DESCRIPTION },
		],
	}),
	component: DocsHome,
});

function GroupSection({ group }: { group: DocGroup }) {
	return (
		<section className="flex flex-col gap-5 border-t py-12">
			<p
				className={cn(
					"flex items-center gap-2 text-sm font-semibold",
					accentText({ tone: group.tone }),
				)}
			>
				<span className="size-2 rounded-full bg-current" />
				{group.title}
			</p>
			<p className="max-w-2xl text-2xl font-extrabold tracking-tight text-balance">
				{group.summary}
			</p>
			<Reveal className="grid gap-3 pt-2 sm:grid-cols-2 lg:grid-cols-3">
				{group.pages.map(({ slug, bot }) => {
					const page = findDocPage(slug);
					if (!page) return null;
					return (
						<RevealItem key={slug}>
							<Link
								to="/docs/$slug"
								params={{ slug }}
								className="group flex h-full items-start gap-4 rounded-3xl bg-card p-5 ring-1 ring-foreground/10 transition hover:-translate-y-0.5 hover:shadow-lg"
							>
								<BotAvatar
									size="lg"
									{...bot}
									className="transition-transform group-hover:-rotate-8 group-hover:scale-110"
								/>
								<span className="flex flex-col gap-1">
									<span className="text-lg font-bold">{page.title}</span>
									<span className="text-sm text-muted-foreground text-pretty">
										{page.description}
									</span>
								</span>
							</Link>
						</RevealItem>
					);
				})}
			</Reveal>
		</section>
	);
}

function DocsHome() {
	const [firstPage] = docPages;
	return (
		<>
			<main className="mx-auto max-w-7xl px-6">
				<section className="pt-12 pb-14">
					<Reveal delay={0.1} className="flex flex-col gap-5">
						<BotCrowd />
						<motion.h1
							variants={riseIn}
							className="text-5xl leading-13 font-black tracking-tight text-balance sm:text-6xl sm:leading-16"
						>
							<span className={accentText({ tone: "emerald" })}>Learn</span> Sugabots.
						</motion.h1>
						<motion.p
							variants={riseIn}
							className="max-w-2xl text-muted-foreground text-pretty sm:text-lg"
						>
							Everything you need to set up a workspace, fill it with <Emphasis>people</Emphasis>{" "}
							and <Emphasis>agents</Emphasis>, and keep it running.
						</motion.p>
						{firstPage && (
							<RevealItem className="flex flex-wrap gap-3">
								<Link
									to="/docs/$slug"
									params={{ slug: firstPage.slug }}
									className={buttonVariants({ size: "lg" })}
								>
									Start with the basics
									<ArrowRightIcon data-icon="inline-end" />
								</Link>
							</RevealItem>
						)}
					</Reveal>
				</section>
				{docGroups.map((group) => (
					<GroupSection key={group.title} group={group} />
				))}
			</main>
			<SiteFooter width="wide" />
		</>
	);
}
