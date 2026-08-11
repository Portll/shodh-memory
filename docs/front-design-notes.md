# Front-end design notes — 2026-08-06

> **Retired 2026-08-07.** `front/index.html` — the single-file vanilla dashboard
> these notes describe — has been deleted, along with `front/assets/d3.v7.min.js`.
> The shipped UI is the React app under `front/ui`, which the `shodh-front`
> binary embeds as one self-contained build artefact; its tokens live in
> `front/ui/src/index.css` and its direction in `front/ui/DIRECTION.md`, which
> supersedes the "next pass" section below.
>
> Kept because the derivations are still the reasoning behind the current
> tokens, not because the surface it describes still exists. The old dashboard
> is recoverable from git history.

## The existing identity (keep it)

The surface is a **SIGINT console**: `#05080d` void ground, phosphor `--accent:#35e0d0`,
saffron/gold/turmeric signal colours, HUD corner-notch panels via `clip-path`,
mono-uppercase structural labels, 44px grid underlay. That is a real point of view and
the right one for the GDELT/IC demo. Sharpen it; do not replace it with a component-kit
look.

## What was missing (fixed in b4e45270)

Font sizes were per-element (19/16/13/12/11/10/9.5/9/8.5px), paddings ad-hoc
(`11px 16px`, `12px 14px`, `7px`), one keyframe plus a single hardcoded `.25s`, shadows
one-off. Added: 1.2 type scale off 13px, 4px spacing rhythm, two easing curves, elevation
by shadow spread, `prefers-reduced-motion`, `:focus-visible` on all controls.

## Watermelon UI — what was actually extracted

`WatermelonCorp/watermellon-registry`, MIT, 1,397 `.tsx`. React 19 + Tailwind v4 + Radix
+ Framer Motion, so the **stack** is not adoptable without a rewrite — but the decisions
are. Measured from `watermelon-ui/ai-input-003.tsx` (frequency counts):

| Their value | Ours | Verdict |
|---|---|---|
| `duration-300` (11 uses) | `--d-base:220ms` | **Adopt 300ms** for settling state; keep 120ms for pointer response. Theirs feels less twitchy. |
| `shadow-sm` dominant, `shadow-none` used deliberately | `--e2` 18px, `--e3` 40px blur | **Soften.** Our elevation is heavier than a console needs. Reserve `--e3` for the one floating menu. |
| `rounded-full` (5), `rounded-md`, `rounded-xl` | flat 6–8px everywhere | **Pill the controls.** Full-round on buttons/chips gives instrument-panel affordance; keep panels square-ish for the HUD notch. |
| `border-neutral-800/50` — translucent borders | solid `--line`/`--line2` | **Highest-value single change.** On a near-black ground a 50%-alpha border reads as an edge rather than a drawn line. |
| `px-4` / `py-3` / `py-2` / `py-1.5` | ad-hoc | Confirms the 4px rhythm already landed. |

Relevant components if a React shell is ever built: `ai-input-001..005`,
`select-ai-agent`, and `dashboards/incident-management` (active-stream views, kanban) —
close in shape to an analyst console.

**Watermelon has no graph or map visualisation.** Nothing d3, nothing canvas. The demo's
centrepiece — the GDELT field collapsing to a needle — is `drawTrace`/canvas code and
stays ours regardless. Watermelon supplies the frame, never the picture.

## Next pass (incremental, no visual risk)

1. Translucent borders — swap `--line`/`--line2` uses for `rgba()` equivalents.
2. Restyle elements to consume the tokens (nothing does yet).
3. Soften elevation; pill the controls.
4. Then the signature moment: the retrieval-collapse animation on the canvas. That is
   where the demo is won, and no token work substitutes for it.

## Deliberately not changed

Two `#58a6ff` uses remain and are **data-encoding**, not chrome: `.scorebar i` (~236)
uses blue→green as a low-to-high scale, and the `Vector idx` series colour (~2002).
Recolouring needs the full categorical palette in view to avoid series collisions.

## Constraint

No build step. Vanilla + d3, single self-contained file — which is also what keeps it
air-gap deployable. Any proposal that requires npm changes that property; make it a
decision, not a drift.
