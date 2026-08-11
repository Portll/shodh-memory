import { useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { sendOAuthInput, startOAuthLogin } from "@/lib/seat/client";
import type { OAuthFlowEvent, ProviderInfo } from "@/lib/seat/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * A subscription/OAuth login, driven entirely by the seat's bridge stream.
 * Everything rendered here is an interaction pi's own flow asked for —
 * auth URLs, device codes, progress lines, a code to paste back. The token
 * exchange happens in the seat process; this component never sees or stores
 * a credential.
 */

type Notice = Extract<OAuthFlowEvent, { kind: "notify" }>["event"];
type Prompt = Extract<OAuthFlowEvent, { kind: "prompt" }>;

export function OAuthFlow({
  provider,
  onDone,
}: {
  provider: ProviderInfo;
  /** Called with the post-login provider status, or null on cancel/failure. */
  onDone: (updated: ProviderInfo | null) => void;
}) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    // Deferred one tick: React StrictMode mounts, unmounts and remounts every
    // effect in development. Starting the flow synchronously fired TWO logins
    // back to back — the second 409'd against the first, and the first's
    // just-opened callback listener made the retry EADDRINUSE. The fake mount's
    // cleanup runs before the timer fires, so only the real mount ever starts.
    const timer = window.setTimeout(() => {
      void startOAuthLogin(
      provider.id,
      (event) => {
        switch (event.kind) {
          case "notify":
            setNotices((current) => [...current, event.event]);
            // A fresh auth URL is the flow asking for a browser; open one.
            if (event.event.type === "auth_url") window.open(event.event.url, "_blank", "noopener");
            break;
          case "prompt":
            setPrompt(event);
            setDraft("");
            break;
          case "prompt_cancelled":
            setPrompt((current) => (current?.prompt_id === event.prompt_id ? null : current));
            break;
          case "complete":
            doneRef.current = true;
            onDone(event.provider);
            break;
          case "error":
            setError(event.message);
            break;
        }
      },
      controller.signal,
      ).catch((cause) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // One flow per mount; provider identity is fixed for the mount's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.id]);

  const answer = (value: string) => {
    if (!prompt || !value.trim()) return;
    void sendOAuthInput(provider.id, prompt.prompt_id, value.trim()).then(() => setPrompt(null));
  };

  return (
    <div className="border-border bg-card mt-2 ml-4 rounded-lg border px-3 py-2.5">
      <div className="flex flex-col gap-1.5">
        {notices.map((notice, index) => {
          switch (notice.type) {
            case "auth_url":
              return (
                <p key={index} className="text-[12px] leading-relaxed">
                  {notice.instructions ?? "Finish signing in in your browser:"}{" "}
                  <a
                    href={notice.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-foreground inline-flex items-center gap-1 underline underline-offset-2"
                  >
                    open login page
                    <ExternalLink aria-hidden="true" className="size-3" />
                  </a>
                </p>
              );
            case "device_code":
              return (
                <div key={index} className="text-[12px] leading-relaxed">
                  Enter this code at{" "}
                  <a
                    href={notice.verificationUri}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-foreground underline underline-offset-2"
                  >
                    {notice.verificationUri}
                  </a>
                  <p className="mono mt-1 text-[15px] font-semibold tracking-widest">
                    {notice.userCode}
                  </p>
                </div>
              );
            case "info":
              return (
                <p key={index} className="text-muted-foreground text-[12px] leading-relaxed">
                  {notice.message}
                  {notice.links?.map((link) => (
                    <a
                      key={link.url}
                      href={link.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-foreground ml-1 underline underline-offset-2"
                    >
                      {link.label ?? link.url}
                    </a>
                  ))}
                </p>
              );
            case "progress":
              return (
                <p key={index} className="text-muted-foreground text-[11px]">
                  {notice.message}
                </p>
              );
            default:
              return null;
          }
        })}
        {notices.length === 0 && !error ? (
          <p className="text-muted-foreground text-[12px]">Starting {provider.name} sign-in…</p>
        ) : null}
      </div>

      {prompt ? (
        prompt.type === "select" ? (
          <div className="mt-2 flex flex-col gap-1">
            <p className="text-[12px]">{prompt.message}</p>
            {(prompt.options ?? []).map((option) => (
              <Button
                key={option.id}
                size="sm"
                variant="outline"
                className="justify-start"
                onClick={() => answer(option.id)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        ) : (
          <form
            className="mt-2 flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              answer(draft);
            }}
          >
            <Input
              autoFocus
              type={prompt.type === "secret" ? "password" : "text"}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={prompt.placeholder ?? prompt.message}
              aria-label={prompt.message}
              autoComplete="off"
              className="max-w-[360px]"
            />
            <Button type="submit" size="sm" disabled={!draft.trim()}>
              Submit
            </Button>
          </form>
        )
      ) : null}

      {error ? <p className="text-destructive mt-2 text-[11px] leading-relaxed">{error}</p> : null}

      <div className="mt-2">
        <Button size="sm" variant="ghost" onClick={() => onDone(null)}>
          {error ? "Close" : "Cancel"}
        </Button>
      </div>
    </div>
  );
}
