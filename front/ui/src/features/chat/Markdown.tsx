import { memo, useMemo } from "react";
import { Marked } from "marked";
import DOMPurify from "dompurify";

/**
 * Assistant text: markdown, sanitized, with memory citations as live elements.
 *
 * Two dependencies carry this and both earn their place. `marked` because
 * every model the seat runs emits markdown, and rendering it as plain text
 * fails the bar this UI is held to (code blocks, lists, tables). `dompurify`
 * because the output of an LLM is untrusted input by definition, and this app
 * ships as an embedded page with no CSP — `dangerouslySetInnerHTML` without a
 * sanitizer is not an option. (react-markdown was the alternative: renders to
 * elements without innerHTML, but at roughly four times the bundle weight of
 * these two combined.)
 *
 * Citations: the seat's system prompt asks the model to cite memories inline
 * as `[mem:<8-hex-id>]` (seat/src/conversation.ts BASE_SYSTEM_PROMPT), and the
 * reinforcement loop keys on exactly that pattern (seat/src/feedback.ts). The
 * same pattern is rewritten here into a <button data-mem> BEFORE markdown
 * parsing, so a citation becomes the thing it is: a handle onto the evidence
 * panel. Buttons and data-* attributes survive DOMPurify's defaults; click
 * handling is delegated from the container, so the sanitized HTML carries no
 * handlers at all.
 */

const marked = new Marked({ gfm: true, breaks: false, async: false });

/** Matches seat/src/feedback.ts extractCitations: [mem:<hex-ish id>]. */
const CITATION = /\[mem:([0-9a-fA-F-]{4,36})\]/g;

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  // External links must not inherit this window (embedded, local-first app).
  if (node.tagName === "A" && node.getAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noreferrer noopener");
  }
});

function render(text: string): string {
  const withCitations = text.replace(
    CITATION,
    (_all, id: string) =>
      `<button type="button" class="mem-cite" data-mem="${id.toLowerCase()}">mem:${id.slice(0, 8).toLowerCase()}</button>`,
  );
  const html = marked.parse(withCitations) as string;
  return DOMPurify.sanitize(html);
}

export const Markdown = memo(function Markdown({
  text,
  onCitationClick,
}: {
  text: string;
  /** Receives the short id from the citation (lowercased, as printed). */
  onCitationClick?: (shortId: string) => void;
}) {
  const html = useMemo(() => render(text), [text]);
  return (
    <div
      className="md text-[13px] leading-relaxed"
      // Sanitized above; see file header.
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const target = (e.target as HTMLElement).closest?.("[data-mem]");
        if (target instanceof HTMLElement && target.dataset.mem && onCitationClick) {
          e.preventDefault();
          onCitationClick(target.dataset.mem);
        }
      }}
    />
  );
});
