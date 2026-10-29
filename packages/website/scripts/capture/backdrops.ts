/**
 * The pictures behind the captures' window, drawn as SVG in the app's greys:
 * the forms of the original wallpapers (a wave with a light ribbon across it,
 * rings, petals, a swoop of bands, and a second wave), each band a gradient
 * from a light to a deep grey. 2240 × 1400, the slides' size; the video's 16:9
 * crops their tops and bottoms.
 */

const WIDTH = 2240;
const HEIGHT = 1400;

/**
 * The families a backdrop is painted in, all of them grey, as the app is: they
 * differ in how light they sit, so neighbouring slides don't repeat. A family
 * names four neighbouring greys for a picture's four kinds of band, each as a
 * light, middle and deep variant.
 */
const families = {
	graphite: {
		ground: ["#d4d4d8", "#71717a", "#18181b"],
		rise: ["#e4e4e7", "#a1a1aa", "#27272a"],
		shadow: ["#a1a1aa", "#52525b", "#09090b"],
		highlight: ["#f4f4f5", "#d4d4d8", "#3f3f46"],
	},
	silver: {
		ground: ["#f4f4f5", "#a1a1aa", "#3f3f46"],
		rise: ["#fafafa", "#d4d4d8", "#52525b"],
		shadow: ["#e4e4e7", "#71717a", "#27272a"],
		highlight: ["#ffffff", "#e4e4e7", "#71717a"],
	},
	ink: {
		ground: ["#71717a", "#3f3f46", "#09090b"],
		rise: ["#a1a1aa", "#52525b", "#18181b"],
		shadow: ["#52525b", "#27272a", "#000000"],
		highlight: ["#d4d4d8", "#71717a", "#27272a"],
	},
} as const;

type Family = keyof typeof families;

/** Which of a family's four shades a band is in. */
type Shade = keyof (typeof families)[Family];

/** One band: an outline filled with a gradient of its shade, from the light end to the deep end along `run`. */
interface Band {
	d: string;
	shade: Shade;
	/** Where the gradient runs, as fractions of the picture: `[x1, y1, x2, y2]`. */
	run: readonly [number, number, number, number];
	/** Start from the middle variant rather than the light one, for a band that should read darker. */
	muted?: boolean;
}

const forms = {
	wave: {
		bands: [
			{
				d: "M0 0H2240V420C1800 300 1500 120 1100 160C760 190 420 60 0 120Z",
				shade: "shadow",
				run: [0, 0, 1, 0.3],
			},
			{
				d: "M820 330C1150 420 1500 520 2240 560V760C1700 700 1300 600 900 460C760 410 700 340 820 330Z",
				shade: "highlight",
				run: [0.4, 0.25, 1, 0.5],
			},
			{
				d: "M0 380C500 300 800 360 1150 520C1500 680 1900 760 2240 760V1400H0Z",
				shade: "ground",
				run: [0, 0.3, 0.8, 1],
				muted: true,
			},
			{
				d: "M0 1000C500 900 900 1080 1300 1250C1600 1380 1900 1400 2240 1350V1400H0Z",
				shade: "rise",
				run: [0, 0.7, 1, 1],
			},
		],
	},
	rings: {
		bands: ringBands(["rise", "ground", "shadow", "highlight", "shadow"]),
	},
	petals: {
		bands: [
			{ d: "M0 0H2240V1400H0Z", shade: "shadow", run: [0, 0, 1, 1], muted: true },
			{
				d: "M0 650C500 640 1000 900 1360 1400H0Z",
				shade: "ground",
				run: [0, 0.5, 0.6, 1],
				muted: true,
			},
			{
				d: "M1180 1400C1400 1000 1900 640 2240 560V1400Z",
				shade: "highlight",
				run: [0.5, 0.4, 1, 1],
			},
			{
				d: "M1500 1400C1700 1200 2000 1000 2240 940V1400Z",
				shade: "shadow",
				run: [0.65, 0.65, 1, 1],
			},
			{
				d: "M2000 1400C2080 1300 2160 1240 2240 1220V1400Z",
				shade: "rise",
				run: [0.9, 0.85, 1, 1],
			},
		],
	},
	swoop: {
		bands: [
			{ d: "M0 0H2240V1400H0Z", shade: "highlight", run: [0, 0, 1, 1], muted: true },
			{
				d: "M0 820C700 980 1300 300 2240 120V700C1400 700 900 1180 0 1080Z",
				shade: "shadow",
				run: [0, 0.4, 1, 0.3],
			},
			{
				d: "M0 1080C900 1180 1400 700 2240 700V1100C1500 1000 1000 1300 0 1300Z",
				shade: "rise",
				run: [0, 0.8, 1, 0.6],
			},
			{
				d: "M0 1300C1000 1300 1500 1000 2240 1100V1400H0Z",
				shade: "ground",
				run: [0, 1, 1, 0.8],
				muted: true,
			},
		],
	},
	sur: {
		bands: [
			{
				d: "M0 0H2240V560C1900 420 1600 240 1200 280C860 310 420 140 0 230Z",
				shade: "rise",
				run: [0, 0, 1, 0.4],
			},
			{
				d: "M900 450C1240 540 1600 640 2240 680V860C1700 800 1300 700 980 580C840 530 780 460 900 450Z",
				shade: "highlight",
				run: [0.4, 0.3, 1, 0.6],
			},
			{
				d: "M0 520C520 420 860 480 1220 640C1580 800 1960 880 2240 860V1400H0Z",
				shade: "ground",
				run: [0, 0.4, 0.8, 1],
				muted: true,
			},
			{
				d: "M0 1100C600 980 1000 1150 1400 1300C1700 1400 2000 1400 2240 1380V1400H0Z",
				shade: "shadow",
				run: [0, 0.8, 1, 1],
			},
		],
	},
} satisfies Record<string, { bands: readonly Band[] }>;

type Form = keyof typeof forms;

/** A backdrop: one of the forms, painted in one family. */
export type Backdrop = { form: Form; family: Family };

/** Rings round the bottom-left corner, widest first, each a thick band of the next shade. */
function ringBands(order: readonly Shade[]): Band[] {
	const thickness = 300;
	return order.map((shade, index) => {
		const outer = 2700 - index * thickness;
		return {
			d: `M0 ${HEIGHT - outer}A${outer} ${outer} 0 0 1 ${outer} ${HEIGHT}H0Z`,
			shade,
			run: [0, 1 - outer / HEIGHT, outer / WIDTH, 1] as const,
			muted: index % 2 === 1,
		};
	});
}

/** The backdrop as an SVG document. */
export function backdropSvg({ form, family }: { form: Form; family: Family }): string {
	const { bands } = forms[form];
	const shades = families[family];
	const gradients = bands
		.map(({ shade, run: [x1, y1, x2, y2], muted }, index) => {
			const [light, middle, deep] = shades[shade];
			return `<linearGradient id="b${index}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" gradientUnits="objectBoundingBox"><stop offset="0" stop-color="${muted ? middle : light}"/><stop offset="${muted ? 0.9 : 0.55}" stop-color="${muted ? deep : middle}"/><stop offset="1" stop-color="${deep}"/></linearGradient>`;
		})
		.join("");
	const shapes = bands.map(({ d }, index) => `<path d="${d}" fill="url(#b${index})"/>`).join("");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><defs>${gradients}</defs><rect width="${WIDTH}" height="${HEIGHT}" fill="${shades.ground[2]}"/>${shapes}</svg>`;
}
