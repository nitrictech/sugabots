import { cn } from "cn";
import { ArrowRightIcon } from "lucide-react";
import { motion } from "motion/react";
import { BotCrowd } from "@/components/bot-crowd";
import { Reveal, RevealItem, riseIn } from "@/components/reveal";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { buttonVariants } from "@/components/ui/button";
import { pageHeading, pageIntro, pageTop, siteColumn } from "@/layout";
import { siteLinks } from "@/site-links";

/** What an address with no page shows, with the way back to the home page and the docs. */
export function NotFoundPage() {
	return (
		<>
			<SiteHeader placement="not_found_header" />
			<main className={cn(siteColumn, pageTop, "pb-24")}>
				<Reveal delay={0.1} className="flex flex-col gap-5">
					<BotCrowd />
					<motion.h1 variants={riseIn} className={pageHeading}>
						Page not found.
					</motion.h1>
					<motion.p variants={riseIn} className={pageIntro}>
						There's no page at this address. The link may be mistyped, or the page may have moved.
					</motion.p>
					<RevealItem className="flex flex-wrap gap-3">
						<a href="/" className={buttonVariants({ size: "lg" })}>
							Go to the home page
						</a>
						<a href={siteLinks.docs} className={buttonVariants({ size: "lg", variant: "outline" })}>
							Read the docs
							<ArrowRightIcon data-icon="inline-end" />
						</a>
					</RevealItem>
				</Reveal>
			</main>
			<SiteFooter />
		</>
	);
}
