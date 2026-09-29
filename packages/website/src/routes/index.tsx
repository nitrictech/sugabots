import { createFileRoute } from "@tanstack/react-router";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { CollaborationSection } from "@/landing/collaboration-section";
import { ExplainerVideo } from "@/landing/explainer-video";
import { FeaturesSection } from "@/landing/features-section";
import { GetStartedSection } from "@/landing/get-started-section";
import { Hero } from "@/landing/hero";
import { ModelsSection } from "@/landing/models-section";
import { OpenSourceSection } from "@/landing/open-source-section";
import { PodsSection } from "@/landing/pods-section";

export const Route = createFileRoute("/")({ component: LandingPage });

function LandingPage() {
	return (
		<>
			<SiteHeader />
			<main id="top" className="mx-auto max-w-3xl px-6">
				<Hero />
				<div className="pb-16">
					<ExplainerVideo />
				</div>
				<PodsSection />
				<CollaborationSection />
				<ModelsSection />
				<FeaturesSection />
				<OpenSourceSection />
				<GetStartedSection />
			</main>
			<SiteFooter />
		</>
	);
}
