import { createFileRoute } from "@tanstack/react-router";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Hero } from "@/landing/hero";
import { PeekingBots } from "@/landing/peeking-bots";
import { PlansSection } from "@/landing/plans-section";
import { ScreenshotCarousel } from "@/landing/screenshot-carousel";
import { VISITOR_OS_SCRIPT } from "@/landing/visitor-os";
import { WorkspaceSection } from "@/landing/workspace-section";
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
		scripts: [
			{ children: VISITOR_OS_SCRIPT },
			{ type: "application/ld+json", children: JSON.stringify(structuredData) },
		],
	}),
	component: LandingPage,
});

function LandingPage() {
	return (
		// The landing page is drawn in the app's dark UI, whatever the visitor's colour scheme.
		<div data-landing className="min-h-screen bg-landing-page text-base/[1.55] text-landing-text">
			<SiteHeader placement="header" homeHref="#top" />
			<main>
				<Hero />
				<WorkspaceSection />
				<ScreenshotCarousel />
				<PlansSection />
				<PeekingBots />
			</main>
			<SiteFooter homeHref="#top" />
		</div>
	);
}
