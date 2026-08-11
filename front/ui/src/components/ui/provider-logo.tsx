import {
  siAnthropic,
  siDeepseek,
  siGooglegemini,
  siHuggingface,
  siLmstudio,
  siMeta,
  siMistralai,
  siOllama,
  siPerplexity,
  siVllm,
} from "simple-icons";
import { cn } from "@/lib/utils";

/**
 * Provider identification marks.
 *
 * These are IDENTIFICATION, not decoration: they exist so "which model is this
 * running on" is answerable at a glance, from the overlay bar, the picker rows
 * and the Providers page. They render at 14-16px in `currentColor`, so they
 * inherit the surrounding text colour and cannot introduce a second accent —
 * and trademarks are never recoloured into the brand accent.
 *
 * Icons are imported BY NAME from `simple-icons` (MIT for the package, CC0 for
 * the icon data) so the bundler keeps only the paths listed above; the package
 * ships 3,453 icons and importing the namespace would pull all of them.
 *
 * OPENAI IS DELIBERATELY ABSENT. simple-icons does not carry it — the only
 * openai-ish export is `siOpenaigym`, an unrelated project — so OpenAI takes
 * the monogram fallback like any other unmapped provider. A near-miss logo is
 * worse than an honest letter: it would assert a brand identity that is not
 * the one being used.
 */

/** pi provider id → icon. Every id absent from this map falls back to a
 *  monogram, which is why an unmapped or newly added provider can never render
 *  a broken image or the wrong company's mark. */
const ICONS: Record<string, { path: string; title: string }> = {
  anthropic: { path: siAnthropic.path, title: siAnthropic.title },
  google: { path: siGooglegemini.path, title: siGooglegemini.title },
  "google-vertex": { path: siGooglegemini.path, title: siGooglegemini.title },
  mistral: { path: siMistralai.path, title: siMistralai.title },
  deepseek: { path: siDeepseek.path, title: siDeepseek.title },
  perplexity: { path: siPerplexity.path, title: siPerplexity.title },
  huggingface: { path: siHuggingface.path, title: siHuggingface.title },
  meta: { path: siMeta.path, title: siMeta.title },
  // The three local providers the seat registers (seat/src/models-registry.ts).
  ollama: { path: siOllama.path, title: siOllama.title },
  lmstudio: { path: siLmstudio.path, title: siLmstudio.title },
  vllm: { path: siVllm.path, title: siVllm.title },
};

export function ProviderLogo({
  provider,
  className,
}: {
  provider: string;
  className?: string;
}) {
  const icon = ICONS[provider];
  const size = cn("size-4 shrink-0", className);

  if (icon) {
    return (
      <svg
        viewBox="0 0 24 24"
        role="img"
        aria-label={icon.title}
        // `currentColor`, so a mark never fights the one-accent rule and always
        // reads against whatever surface it lands on.
        fill="currentColor"
        className={size}
      >
        <path d={icon.path} />
      </svg>
    );
  }

  // Monogram fallback: first letter in a rounded square, muted. Never a broken
  // image, never another provider's logo.
  return (
    <span
      aria-label={provider}
      role="img"
      className={cn(
        "bg-muted text-muted-foreground flex items-center justify-center rounded-[3px] text-[9px] font-semibold uppercase",
        size,
      )}
    >
      {provider.slice(0, 1)}
    </span>
  );
}
