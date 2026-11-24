import { describe, expect, it } from "vitest";
import { imageTypeOf } from "./artifacts.ts";

const bytes = (...parts: (string | number[])[]) =>
	new Uint8Array(
		parts.flatMap((part) =>
			typeof part === "string" ? [...part].map((character) => character.charCodeAt(0)) : part,
		),
	);

describe("imageTypeOf", () => {
	it("tells each kind of image a document keeps by the bytes it starts with", () => {
		expect(imageTypeOf(bytes([0x89], "PNG\r\n", [0x1a, 0x0a, 0, 0, 0, 13], "IHDR"))).toBe(
			"image/png",
		);
		expect(imageTypeOf(bytes([0xff, 0xd8, 0xff, 0xe0, 0, 16], "JFIF"))).toBe("image/jpeg");
		expect(imageTypeOf(bytes("GIF87a", [1, 0, 1, 0]))).toBe("image/gif");
		expect(imageTypeOf(bytes("GIF89a", [1, 0, 1, 0]))).toBe("image/gif");
		expect(imageTypeOf(bytes("RIFF", [26, 0, 0, 0], "WEBPVP8 "))).toBe("image/webp");
	});

	it("tells no kind for bytes that start as none of them", () => {
		expect(imageTypeOf(bytes("BM", [0x36, 0, 0, 0]))).toBeUndefined();
		expect(imageTypeOf(bytes("RIFF", [26, 0, 0, 0], "WAVEfmt "))).toBeUndefined();
		expect(imageTypeOf(bytes("GIF88a"))).toBeUndefined();
		expect(imageTypeOf(bytes([0x89], "PNG"))).toBeUndefined();
		expect(imageTypeOf(bytes("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeUndefined();
		expect(imageTypeOf(new Uint8Array())).toBeUndefined();
	});
});
