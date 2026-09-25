import { motion } from "motion/react";
import { BotAvatar } from "@/components/bot-avatar";
import { EarlyAccessLink } from "@/components/early-access-link";
import { Reveal, RevealItem, riseIn } from "@/components/reveal";
import { buttonVariants } from "@/components/ui/button";
import { launched, siteLinks } from "@/site-links";

export function GetStartedSection() {
	return (
		<section id="start" className="border-t pt-20 pb-24 text-center">
			<Reveal className="flex flex-col items-center gap-6">
				<Reveal stagger={0.08} className="flex gap-1.5" aria-hidden>
					<RevealItem variant="pop">
						<BotAvatar size="lg" color="green" face="bar" className="translate-y-1" />
					</RevealItem>
					<RevealItem variant="pop">
						<BotAvatar size="lg" color="orange" face="dots" />
					</RevealItem>
					<RevealItem variant="pop">
						<BotAvatar size="lg" color="purple" face="smile" className="translate-y-1" />
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
					{launched ? (
						<>
							<a href={siteLinks.docs} className={buttonVariants({ size: "lg" })}>
								Read the docs
							</a>
							<a
								href={siteLinks.github}
								className={buttonVariants({ variant: "outline", size: "lg" })}
							>
								View on GitHub
							</a>
						</>
					) : (
						<EarlyAccessLink size="lg" />
					)}
				</RevealItem>
			</Reveal>
		</section>
	);
}
