# TokenLens launch site

A static, single-page launch website for
[TokensLens](https://github.com/Ashutosh-Panda2004/TokensLens) — built to the
spec in the repo's `WEBSITE-BRIEF.md`. Dark "instrument" aesthetic, CLI-flavoured
terminals, a faithful recreation of the real dashboard (from
`packages/core/src/dashboard` source), an annotated element-anatomy overlay,
the downloadable-report preview, all 14 waste causes, the Meridian scenario,
and the interactive savings calculator.

Pure static files — no build step, no backend. Deploys anywhere static hosting works.

```
site/
├── index.html   # all 20 sections
├── styles.css   # the design system
├── app.js       # interactions (GSAP ScrollTrigger via CDN)
```

## Deploy to Vercel (2 minutes)

**Option A — drag & drop**
1. Go to https://vercel.com/new
2. Drag the `site/` folder contents (`index.html`, `styles.css`, `app.js`) into the
   deploy area. Done — you get a `*.vercel.app` URL.

**Option B — from a repo**
1. Put the `site/` folder in any GitHub repo.
2. Vercel → New Project → import the repo. Framework preset: **Other**.
   No build command, no output directory changes needed.

Then add the URL to the TokensLens repo: GitHub → repo → ⚙ (About) →
**Website** field → paste the Vercel URL → Save. (Also settable via API:
`PATCH /repos/Ashutosh-Panda2004/TokensLens` with `{"homepage": "<url>"}`.)

## Local preview

```sh
cd site && python3 -m http.server 8901
# open http://localhost:8901
```

## Notes

- Every figure on the page carries a provenance chip (`measured` / `modelled` /
  `~N% measured`), per the brief's data appendix. Don't add a number without one.
- Fonts (Instrument Sans, Inter, JetBrains Mono) and GSAP load from CDN.
  The page works without them, minus the webfonts and pinned scroll choreography.
- Pinned scroll sections unpin below 1024px and under `prefers-reduced-motion`.
- The dashboard recreation is reconstructed from the tool's actual dashboard
  source with the live figures from the brief — time-series shapes are marked
  illustrative in the captions.
