import type { HtmlReader } from "@sugabots/contracts/deck-html";
import { DOMParser } from "linkedom";

/**
 * Reads HTML with linkedom's `DOMParser`, into a page of its own that runs
 * none of its scripts and loads none of its images or styles: how the API
 * reads a deck's HTML, which a bot may have written (see `HtmlReader`).
 */
export const readHtml: HtmlReader = new DOMParser();
