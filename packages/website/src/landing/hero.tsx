import { cn } from "cn";
import { trackCallToActionClick } from "@/analytics";
import { callToAction } from "@/landing/call-to-action";
import { DemoVideo } from "@/landing/demo-video";
import { pageTop, siteColumn } from "@/layout";
import { siteLinks } from "@/site-links";
import { siteMeta } from "@/site-meta";

export function Hero() {
	return (
		<section id="top" className={cn(siteColumn, pageTop, "flex flex-col gap-16 sm:gap-24")}>
			<div className="flex flex-col items-start gap-7">
				<h1 className="max-w-205 text-4xl md:text-6xl lg:text-7xl/none font-bold tracking-tight text-balance">
					{siteMeta.headline}.
				</h1>
				<p className="max-w-140 text-lg lg:text-xl/normal text-pretty text-landing-muted">
					{siteMeta.description}
				</p>
				<div className="mt-1 flex flex-wrap gap-3">
					<a
						href={siteLinks.selfHost}
						onClick={() => trackCallToActionClick("self_host", "hero")}
						className={callToAction()}
					>
						Self-host it
					</a>
					<a
						href={siteLinks.waitlist}
						onClick={() => trackCallToActionClick("waitlist", "hero")}
						className={callToAction({ variant: "secondary" })}
					>
						Join the waitlist
					</a>
				</div>
			</div>
			<DemoVideo />
		</section>
	);
}
