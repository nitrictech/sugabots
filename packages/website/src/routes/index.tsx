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
import { siteLinks } from "@/site-links";
import { siteMeta } from "@/site-meta";

const LICENSE_URL = `${siteLinks.github}/blob/main/LICENSE.md`;

const nitric = {
	"@type": "Organization",
	"@id": "https://nitric.io/#organization",
	name: "Nitric",
	legalName: "Nitric Group Inc.",
	url: "https://nitric.io",
};

const website = {
	"@type": "WebSite",
	"@id": `${siteMeta.url}/#website`,
	name: "Sugabots",
	url: siteMeta.url,
	publisher: { "@id": nitric["@id"] },
};

const sugabots = {
	"@type": "SoftwareApplication",
	"@id": `${siteMeta.url}/#software`,
	name: "Sugabots",
	description: siteMeta.description,
	url: siteMeta.url,
	image: `${siteMeta.url}${siteMeta.ogImagePath}`,
	applicationCategory: "DeveloperApplication",
	operatingSystem: "Web, Docker",
	license: LICENSE_URL,
	isAccessibleForFree: true,
	offers: { "@type": "Offer", price: 0, priceCurrency: "USD" },
	publisher: { "@id": nitric["@id"] },
};

const sourceCode = {
	"@type": "SoftwareSourceCode",
	"@id": `${siteMeta.url}/#source-code`,
	name: "Sugabots",
	codeRepository: siteLinks.github,
	programmingLanguage: "TypeScript",
	license: LICENSE_URL,
	targetProduct: { "@id": sugabots["@id"] },
};

/** Who and what the site is about, as schema.org data for search engines and agents. */
const structuredData = {
	"@context": "https://schema.org",
	"@graph": [nitric, website, sugabots, sourceCode],
};

export const Route = createFileRoute("/")({
	head: () => ({
		scripts: [{ type: "application/ld+json", children: JSON.stringify(structuredData) }],
	}),
	component: LandingPage,
});

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
