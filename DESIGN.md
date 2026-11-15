# Pialy design

The visual system of the web app (`apps/web`). Product truth lives in PRODUCT.md (kept local).

## World
- Paper is pure white; ink is near-black. A pale cobalt 32px agenda grid (`.grid-bg`) sits behind booking and marketing surfaces.
- Color only ever says payment state: cobalt `brand` = held / action, green `paid` = confirmed by the bank, amber `late` = late payment or refund due, `gone` = expired or taken.
- Type: Archivo (variable width) for UI; Doto dot-matrix numerals for the big times and amounts.
- Thin 1px ink rules and 2px corners (`radius-sm`). Taken slots are hatched (`.hatched`) and struck through.
- Light only: no dark mode, gradients, glass, shadows, stock icons or photos.

## Tokens
Only the tokens in `apps/web/src/styles/theme.css`: `ink, paper, muted, grid, brand, brand-wash, paid, paid-wash, late, late-wash, gone`, fonts `ui` / `display`, `radius-sm`, animations `pulse-ring`, `sweep`, `rise`. `prefers-reduced-motion` disables all animation globally.

## Primitives (cva)
`Button` / `buttonClass` (solid, ghost, brand, late; min height 44–56px), `Numeral` (Doto sizes; pass `size="sheet"` when overriding the size so the responsive `hero` size does not win), `Panel`, `Label`, `KeyValues`, `StatusTag` / `StatusPill` (tones from `ui/status.ts`), `Sheet`, `Field`.

## Surfaces
| Route | Surface |
|---|---|
| `/` | Public landing (persuade). |
| `/estudio-demo` | Customer booking for the synthetic "Estudio Demo". Defaults to the first of 5 days with a free slot. |
| `/c/:token` | Wait screen (countdown, QR fallback) → pass. |
| `/negocio*` | Owner board (PIN), pass verification. |

## Landing direction contract
- THESIS: the page is a live appointment slot. The hero loops a slot free → "Alguien paga" with a Doto 06:00 countdown → green "Anticipo pagado" (~9 s, one loop drives every animated element). Refuses: centered hero, feature-card grid, testimonials.
- FIRST VIEWPORT (390×844): mark, h1 value prop, live slot card, primary CTA "Probar la demo · $0.01" above the fold. Desktop: copy left; customer phone + owner board right, synchronized to the same loop.
- STORY: no-show cost → CoDi® deposit to the bank app → hold lives 6 min, bank confirms → owner hears "Anticipo recibido", door scans the pass → edge cases → try it.
- Proof: only the flow (example data labeled "Ejemplo") and the factual real $0.01 tests with BBVA. No customers, metrics, logos or prices.
- Reduced motion: static paid state, no timer.

## Finish review (landing, 2026-11-14)
- Checked at 390×844 and 1440×900: no horizontal scroll, every link/button ≥ 44px tall, one h1, landmarks (header/main/footer), `lang="es-MX"`, title, description and og tags.
- Verdict: ships. Known trade-offs: the example board rows keep the app's Archivo times (faithful to the real screen) while landing-native times use Doto; the hero countdown ticks in real seconds, so a loop shows only 06:00 → 05:56 before paid.
