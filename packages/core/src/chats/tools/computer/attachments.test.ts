import { describe, expect, it } from "vitest";
import { safeFileName } from "./attachments.ts";

describe("the name an attachment is copied under in the computer", () => {
	it("keeps an ordinary name as it is", () => {
		expect(safeFileName("Q3 report (final).pdf")).toBe("Q3 report (final).pdf");
		expect(safeFileName("café menu.csv")).toBe("café menu.csv");
	});

	it("keeps the name one file, however it was written", () => {
		expect(safeFileName("../../etc/passwd")).toBe("_.._etc_passwd");
		expect(safeFileName("C:\\Users\\sam\\notes.txt")).toBe("C:_Users_sam_notes.txt");
		expect(safeFileName("..")).toBe("file");
	});

	it("never makes a hidden file, or one a command reads as an option", () => {
		expect(safeFileName(".env")).toBe("env");
		expect(safeFileName("-rf")).toBe("rf");
	});

	it("leaves out characters that break a line or reorder how the name shows", () => {
		// A right-to-left override shows "invoice‮fdp.exe" as "invoiceexe.pdf".
		expect(safeFileName("invoice\u202Efdp.exe")).toBe("invoicefdp.exe");
		expect(safeFileName("a\u007Fb.txt")).toBe("a_b.txt");
	});

	it("cuts a long name to what Linux allows, in bytes, keeping its extension", () => {
		const name = `${"é".repeat(300)}.pdf`;
		const kept = safeFileName(name);

		expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(255);
		expect(kept.endsWith("é.pdf")).toBe(true);
	});
});
