/**
 * The pictures behind the captures' window, drawn as SVG, each in one of the
 * logo's four colours: the forms of the original wallpapers (a wave with a light ribbon
 * across it, rings, petals, a swoop of bands, and a second wave), each band a
 * gradient from a light to a deep variant of one colour. 2240 × 1400, the
 * slides' size; the video's 16:9 crops their tops and bottoms.
 */

const WIDTH = 2240;
const HEIGHT = 1400;

/**
 * The families a backdrop is painted in, one per logo colour, two more from
 * the bots' purple and teal, and the site's indigo, so each picture keeps to a single colour as
 * the original purple ones did. A family names
 * four neighbouring shades for a picture's four kinds of band, each as a light,
 * middle and deep variant; `blue` is the logo's own blue, and so on.
 */
const families = {
	blue: {
		blue: ["#bae6fd", "#38bdf8", "#0c4a6e"],
		green: ["#a5f3fc", "#06b6d4", "#164e63"],
		red: ["#bfdbfe", "#3b82f6", "#1e3a8a"],
		orange: ["#e0f2fe", "#7dd3fc", "#075985"],
	},
	// Pine rather than lime, so it reads as forest, not moss.
	green: {
		blue: ["#6ee7b7", "#047857", "#022c22"],
		green: ["#86efac", "#15803d", "#052e16"],
		red: ["#5eead4", "#0f766e", "#042f2e"],
		orange: ["#4ade80", "#166534", "#052e16"],
	},
	// Its light ends kept rich: pale pinks read as washed out against the deep reds.
	red: {
		blue: ["#f87171", "#dc2626", "#7f1d1d"],
		green: ["#fb7185", "#e11d48", "#831843"],
		red: ["#f43f5e", "#e11d48", "#881337"],
		orange: ["#fb7185", "#be123c", "#4c0519"],
	},
	orange: {
		blue: ["#fde68a", "#f59e0b", "#78350f"],
		green: ["#fef3c7", "#fbbf24", "#92400e"],
		red: ["#ffedd5", "#fb923c", "#9a3412"],
		orange: ["#fed7aa", "#f97316", "#7c2d12"],
	},
	// The logo's four colours, one to a band, for a backdrop in all of them.
	logo: {
		blue: ["#bae6fd", "#38bdf8", "#0c4a6e"],
		green: ["#bbf7d0", "#22c55e", "#14532d"],
		red: ["#fecdd3", "#f43f5e", "#881337"],
		orange: ["#fed7aa", "#f97316", "#7c2d12"],
	},
	indigo: {
		blue: ["#c7d2fe", "#6366f1", "#312e81"],
		green: ["#dbeafe", "#818cf8", "#1e3a8a"],
		red: ["#e0e7ff", "#4f46e5", "#1e1b4b"],
		orange: ["#eef2ff", "#a5b4fc", "#3730a3"],
	},
	purple: {
		blue: ["#ddd6fe", "#8b5cf6", "#4c1d95"],
		green: ["#f5d0fe", "#d946ef", "#701a75"],
		red: ["#e9d5ff", "#a855f7", "#581c87"],
		orange: ["#e0e7ff", "#818cf8", "#312e81"],
	},
	teal: {
		blue: ["#99f6e4", "#14b8a6", "#134e4a"],
		green: ["#a5f3fc", "#06b6d4", "#164e63"],
		red: ["#a7f3d0", "#10b981", "#064e3b"],
		orange: ["#ccfbf1", "#2dd4bf", "#115e59"],
	},
} as const;

type Family = keyof typeof families;

/** Which of a family's four shades a band is in. */
type Hue = keyof (typeof families)[Family];

/** One band: an outline filled with a gradient of its shade, from the light end to the deep end along `run`. */
interface Band {
	d: string;
	hue: Hue;
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
				hue: "red",
				run: [0, 0, 1, 0.3],
			},
			{
				d: "M820 330C1150 420 1500 520 2240 560V760C1700 700 1300 600 900 460C760 410 700 340 820 330Z",
				hue: "orange",
				run: [0.4, 0.25, 1, 0.5],
			},
			{
				d: "M0 380C500 300 800 360 1150 520C1500 680 1900 760 2240 760V1400H0Z",
				hue: "blue",
				run: [0, 0.3, 0.8, 1],
				muted: true,
			},
			{
				d: "M0 1000C500 900 900 1080 1300 1250C1600 1380 1900 1400 2240 1350V1400H0Z",
				hue: "green",
				run: [0, 0.7, 1, 1],
			},
		],
	},
	rings: {
		bands: ringBands(["green", "blue", "red", "orange", "red"]),
	},
	petals: {
		bands: [
			{ d: "M0 0H2240V1400H0Z", hue: "red", run: [0, 0, 1, 1], muted: true },
			{
				d: "M0 650C500 640 1000 900 1360 1400H0Z",
				hue: "blue",
				run: [0, 0.5, 0.6, 1],
				muted: true,
			},
			{ d: "M1180 1400C1400 1000 1900 640 2240 560V1400Z", hue: "orange", run: [0.5, 0.4, 1, 1] },
			{ d: "M1500 1400C1700 1200 2000 1000 2240 940V1400Z", hue: "red", run: [0.65, 0.65, 1, 1] },
			{
				d: "M2000 1400C2080 1300 2160 1240 2240 1220V1400Z",
				hue: "green",
				run: [0.9, 0.85, 1, 1],
			},
		],
	},
	swoop: {
		bands: [
			{ d: "M0 0H2240V1400H0Z", hue: "orange", run: [0, 0, 1, 1], muted: true },
			{
				d: "M0 820C700 980 1300 300 2240 120V700C1400 700 900 1180 0 1080Z",
				hue: "red",
				run: [0, 0.4, 1, 0.3],
			},
			{
				d: "M0 1080C900 1180 1400 700 2240 700V1100C1500 1000 1000 1300 0 1300Z",
				hue: "green",
				run: [0, 0.8, 1, 0.6],
			},
			{
				d: "M0 1300C1000 1300 1500 1000 2240 1100V1400H0Z",
				hue: "blue",
				run: [0, 1, 1, 0.8],
				muted: true,
			},
		],
	},
	sur: {
		bands: [
			{
				d: "M0 0H2240V560C1900 420 1600 240 1200 280C860 310 420 140 0 230Z",
				hue: "green",
				run: [0, 0, 1, 0.4],
			},
			{
				d: "M900 450C1240 540 1600 640 2240 680V860C1700 800 1300 700 980 580C840 530 780 460 900 450Z",
				hue: "orange",
				run: [0.4, 0.3, 1, 0.6],
			},
			{
				d: "M0 520C520 420 860 480 1220 640C1580 800 1960 880 2240 860V1400H0Z",
				hue: "blue",
				run: [0, 0.4, 0.8, 1],
				muted: true,
			},
			{
				d: "M0 1100C600 980 1000 1150 1400 1300C1700 1400 2000 1400 2240 1380V1400H0Z",
				hue: "red",
				run: [0, 0.8, 1, 1],
			},
		],
	},
} satisfies Record<string, { bands: readonly Band[] }>;

type Form = keyof typeof forms;

/** A backdrop: one of the forms, painted in one family. */
export type Backdrop = { form: Form; family: Family };

/** Rings round the bottom-left corner, widest first, each a thick band of the next hue. */
function ringBands(order: readonly Hue[]): Band[] {
	const thickness = 300;
	return order.map((hue, index) => {
		const outer = 2700 - index * thickness;
		return {
			d: `M0 ${HEIGHT - outer}A${outer} ${outer} 0 0 1 ${outer} ${HEIGHT}H0Z`,
			hue,
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
		.map(({ hue, run: [x1, y1, x2, y2], muted }, index) => {
			const [light, middle, deep] = shades[hue];
			return `<linearGradient id="b${index}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" gradientUnits="objectBoundingBox"><stop offset="0" stop-color="${muted ? middle : light}"/><stop offset="${muted ? 0.9 : 0.55}" stop-color="${muted ? deep : middle}"/><stop offset="1" stop-color="${deep}"/></linearGradient>`;
		})
		.join("");
	const shapes = bands.map(({ d }, index) => `<path d="${d}" fill="url(#b${index})"/>`).join("");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><defs>${gradients}</defs><rect width="${WIDTH}" height="${HEIGHT}" fill="${shades.blue[2]}"/>${shapes}</svg>`;
}
