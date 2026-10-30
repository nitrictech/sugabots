import { type Emoji, type EmojiDataset, loadEmojiDataset } from "@sugabots/emoji";
import type { EmojiData, EmojiDataResolver } from "frimousse";
import { useEffect, useState } from "react";

/**
 * The emoji the app offers, wherever one is chosen: the picker and the
 * shortcodes typed in a draft read the same ones. They are those of
 * `@sugabots/emoji` this browser's fonts can draw, as an older one has no
 * glyph for the newest emoji and Windows draws a country's flag as two
 * letters. They load once for the page, from a file built with the app.
 */
export interface AvailableEmoji extends EmojiData {
	emojis: Emoji[];
}

/** The one locale the dataset is in. */
const LOCALE = "en";

/**
 * The emoji, once loaded. Calling it starts loading them, so a component that
 * will offer emoji uses it when it mounts and has them before anyone asks.
 */
export function useAvailableEmoji(): AvailableEmoji | undefined {
	const [emoji, setEmoji] = useState(loaded);
	useEffect(() => {
		if (emoji) return;
		let current = true;
		loadAvailableEmoji().then(
			(available) => {
				if (current) setEmoji(available);
			},
			// The picker reports its own failure; a draft is written as typed, colons and all.
			() => {},
		);
		return () => {
			current = false;
		};
	}, [emoji]);
	return emoji;
}

/**
 * The emoji, for the picker. Already loaded, as they usually are by the time
 * it opens, they are handed over at once, so it shows no loading state.
 */
export const resolveEmojiData: EmojiDataResolver = () => loaded ?? loadAvailableEmoji();

let loaded: AvailableEmoji | undefined;
let loading: Promise<AvailableEmoji> | undefined;

function loadAvailableEmoji(): Promise<AvailableEmoji> {
	loading ??= loadEmojiDataset().then(
		(dataset) => {
			loaded = availableOf(dataset);
			return loaded;
		},
		(failure: unknown) => {
			// Asking again tries again.
			loading = undefined;
			throw failure;
		},
	);
	return loading;
}

function availableOf(dataset: EmojiDataset): AvailableEmoji {
	const newestVersion = newestDrawableVersion(dataset.emojis);
	const drawsFlags = canDraw(FLAG_SAMPLE);
	return {
		...dataset,
		locale: LOCALE,
		emojis: dataset.emojis.filter(
			(emoji) => emoji.version <= newestVersion && (!emoji.countryFlag || drawsFlags),
		),
	};
}

/** Drawn as a flag only where the fonts draw country flags. */
const FLAG_SAMPLE = "🇪🇺";

/**
 * The newest Emoji version this browser draws, found by trying the first
 * emoji of each, newest first. Fonts gain a version's emoji all at once.
 */
function newestDrawableVersion(emojis: readonly Emoji[]): number {
	const sampleOfVersion = new Map<number, string>();
	for (const { version, emoji } of emojis) {
		if (!sampleOfVersion.has(version)) sampleOfVersion.set(version, emoji);
	}
	const newestFirst = [...sampleOfVersion].sort(([a], [b]) => b - a);
	const drawable = newestFirst.find(([, sample]) => canDraw(sample));
	return drawable?.[0] ?? newestFirst[0]?.[0] ?? 0;
}

/** The fonts the picker draws emoji in, as Frimousse sets them. */
const EMOJI_FONTS =
	"'Apple Color Emoji', 'Noto Color Emoji', 'Twemoji Mozilla', 'Android Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', EmojiSymbols, sans-serif";

/** Big enough to hold one emoji's colours, small enough to read back at once. */
const CANVAS_SIZE = 2;

/**
 * Whether the fonts draw `emoji` as one coloured glyph. One they lack is drawn
 * as a box or several glyphs side by side, or in the text colour. Without a
 * canvas, as in tests, every emoji counts as drawable.
 */
function canDraw(emoji: string): boolean {
	if (typeof OffscreenCanvas === "undefined") return true;
	const context = new OffscreenCanvas(CANVAS_SIZE, CANVAS_SIZE).getContext("2d", {
		willReadFrequently: true,
	});
	if (!context) return true;
	context.font = `${CANVAS_SIZE}px ${EMOJI_FONTS}`;
	context.textBaseline = "middle";
	// A sequence the fonts cannot join is drawn as its parts, wider than one glyph.
	if (context.measureText(emoji).width >= CANVAS_SIZE * 2) return false;
	const inColour = (fill: string) => {
		context.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
		context.fillStyle = fill;
		context.fillText(emoji, 0, 0);
		return context.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE).data;
	};
	const blue = inColour("#00f");
	const red = inColour("#f00");
	// An emoji keeps its own colours whatever the text colour is.
	return blue.every((channel, index) => index % 4 === 3 || channel === red[index]);
}
