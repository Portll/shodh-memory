import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * The message input. Enter sends, Shift+Enter breaks — the convention every
 * product at this bar has trained; the textarea grows with content up to a
 * cap so a pasted paragraph stays visible without swallowing the transcript.
 */
export function Composer({
  disabled,
  disabledReason,
  onSend,
}: {
  disabled: boolean;
  /** Shown as the placeholder when the composer cannot send. */
  disabledReason?: string;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow: measure content height, cap at ~7 lines.
  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "0";
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
  }, [draft]);

  const send = () => {
    const text = draft.trim();
    if (!text || disabled) return;
    setDraft("");
    onSend(text);
  };

  return (
    <form
      className="border-border bg-background shrink-0 border-t px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <div
        className={cn(
          "border-input bg-card mx-auto flex w-full max-w-[760px] items-end gap-2 rounded-lg border px-3 py-2",
          "focus-within:border-ring focus-within:ring-ring/40 focus-within:ring-2",
          disabled && "opacity-60",
        )}
      >
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          disabled={disabled}
          rows={1}
          placeholder={disabled ? (disabledReason ?? "Unavailable") : "Message the seat…"}
          aria-label="Message"
          className={cn(
            "placeholder:text-muted-foreground min-h-[22px] flex-1 resize-none bg-transparent text-[13px] leading-relaxed",
            "focus:outline-none disabled:cursor-not-allowed",
          )}
        />
        <Button
          type="submit"
          size="icon"
          aria-label="Send message"
          disabled={disabled || !draft.trim()}
          className="size-7 rounded-md"
        >
          <ArrowUp />
        </Button>
      </div>
    </form>
  );
}
