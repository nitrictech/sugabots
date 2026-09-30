import { motion } from "motion/react";
import { trackCallToActionClick } from "@/analytics";
import { BotAvatar } from "@/components/bot-avatar";
import { Reveal, RevealItem, riseIn } from "@/components/reveal";
import { buttonVariants } from "@/components/ui/button";
import { siteLinks } from "@/site-links";

export function GetStartedSection() {
	return (
		<section id="start" className="border-t pt-20 pb-24 text-center">
			<Reveal className="flex flex-col items-center gap-6">
				<Reveal stagger={0.08} className="flex gap-1.5" aria-hidden>
					<RevealItem variant="pop">
						<BotAvatar size="lg" color="green" face="pill" className="translate-y-1" />
					</RevealItem>
					<RevealItem variant="pop">
						<BotAvatar size="lg" color="orange" face="dot" />
					</RevealItem>
					<RevealItem variant="pop">
						<BotAvatar size="lg" color="purple" face="arc" className="translate-y-1" />
					</RevealItem>
				</Reveal>
				<motion.h2
					variants={riseIn}
					className="text-5xl font-black leading-none tracking-tighter sm:text-6xl"
				>
					Start a pod.
				</motion.h2>
				<motion.p variants={riseIn} className="max-w-md text-muted-foreground">
					Set it up in a few minutes, invite your people, and add your first bot.
				</motion.p>
				<RevealItem className="flex flex-wrap justify-center gap-3">
					<a
						href={siteLinks.docs}
						onClick={() => trackCallToActionClick("docs", "get_started_section")}
						className={buttonVariants({ size: "lg" })}
					>
						Read the docs
					</a>
					<a
						href={siteLinks.github}
						onClick={() => trackCallToActionClick("github", "get_started_section")}
						className={buttonVariants({ variant: "outline", size: "lg" })}
					>
						View on GitHub
					</a>
				</RevealItem>
			</Reveal>
		</section>
	);
}
