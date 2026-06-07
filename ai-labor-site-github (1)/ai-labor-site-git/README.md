# AI × Labor — Will This Job Survive?

An interactive model of how AI affects employment by profession. Type a job; the app
maps it to real US Bureau of Labor Statistics employment and wage data, asks Claude to
estimate ~14 economic parameters, and runs a 30-year dynamic simulation showing
employment, average income, AI capability, and market demand.

Professions are classified into three buckets — **Mind** (knowledge/code), **Hand**
(physical work, gated by a robotics-arrival slider), and **Heart** (work where people
specifically want a human) — each with its own automation ceilings and capability curve.

## Stack

- **Front end**: a single self-contained `public/index.html` (no build step).
- **Back end**: one Netlify serverless function (`netlify/functions/estimate.mjs`) that
  proxies to Claude, holds the system prompts server-side, rate limits per IP, and caches
  results in Netlify Blobs.

No Anthropic API key lives in the repo or the client. Either Netlify's AI Gateway injects
credentials at runtime (billed as Netlify credits), or you set your own `ANTHROPIC_API_KEY`
as a Netlify environment variable (billed to your Anthropic account).

## Run / deploy

```bash
npm install                  # restore dependencies (Anthropic SDK, Netlify Blobs)
npm install -g netlify-cli   # if you don't already have it

netlify dev                  # local dev with the function running
netlify deploy --prod        # deploy to your Netlify site
```

Or connect this GitHub repo to a Netlify site (Add new site → Import from Git) and let
Netlify build on push. The publish directory and functions path are already set in
`netlify.toml`, so no extra build configuration is needed.

For credentials, either enable **AI Gateway** (Site settings → AI Gateway) or set
`ANTHROPIC_API_KEY` as a Netlify environment variable.

## Project layout

```
.
├── public/index.html                ← the app (single self-contained file)
├── netlify/functions/estimate.mjs   ← serverless proxy: BLS lookup + parameter estimation
├── netlify.toml                     ← publish + functions config
├── package.json / package-lock.json ← deps
└── README.md
```

(`node_modules/` is git-ignored — run `npm install` to restore it.)

---

# How the model works

## Phase 1 — Query & estimation

When you type a profession, the app makes **two parallel calls** to a single serverless
function (`/api/estimate`), each going to Claude with a different system prompt. Results
are cached in Netlify Blobs, so each profession is only ever estimated once.

### Call 1 — BLS grounding (`type: "bls"`)

**What's sent:** your free-text profession plus a catalog of ~830 detailed occupations
from the **US Bureau of Labor Statistics OEWS survey**, each row carrying its SOC code,
title, US employment, and median annual wage. This catalog is baked into the app — it is
the only hard data source; everything else is estimation.

**What Claude returns:**

| Field | Meaning |
|---|---|
| `codes` | One or more SOC codes whose union best matches what you typed (e.g. "plumber" → `47-2152`) |
| `adjusted_estimate` | If your profession is a *subset* of a SOC bucket ("pediatric nurse" ⊂ "Registered Nurses"), Claude's estimate of the subset's headcount — required to be smaller than the bucket total |
| `adjusted_wage` | Optional wage correction when the specific profession plausibly earns differently from its bucket average |
| `confidence`, `basis` | How sure the match is, and one sentence of reasoning |

**How the app uses it:** employment is the sum of the matched codes' BLS headcounts (or
the adjusted estimate, clamped to never exceed the bucket); wage is the
employment-weighted median across the matched codes (or the adjusted wage, clamped to
0.4–2.5× the anchor). These two numbers pin the simulation's year-0 axes to reality. If
BLS doesn't track the job (podcaster, influencer), the charts fall back to an index where
100 = today.

### Call 2 — Parameter estimation (`type: "params"`)

Claude is given the profession plus a calibration sheet containing fully worked examples
(software engineer, lawyer, tax accountant, plumber, surgeon, warehouse picker, …) and
asked to return one classification plus 14 numbers. Every number is range-clamped
client-side, so a wild estimate can't break the model.

**The classification — `workKind`:** `"mind"` (knowledge/code — AI needs no body),
`"hand"` (physical work where the *output* is what's wanted, so a capable machine is an
acceptable substitute), or `"heart"` (people specifically want a *human* doing it —
performers, therapists, clergy). This sets a hard ceiling on how much of the core can
ever be automated: 100% for mind and hand, **0% for heart**.

**The 14 parameters:**

| Parameter | Range | What it means |
|---|---|---|
| `currentAutomatable` | 0.01–0.60 | Share of the job's tasks today's AI can already do |
| `productivityToday` | 1–30× | How much faster AI is at those tasks today |
| `productivityCeiling` | 2–100× | How much faster it eventually gets (low for physics-bound work) |
| `aiCostToday` | 0.02–1.0 | Cost of an AI hour as a fraction of a human hour |
| `aiCostDecayRate` | 0–45%/yr | Annual decline in that cost (fast for software, slow for robots) |
| `demandElasticity` | 0–4 | % demand growth per 1% price drop (the market-expansion engine) |
| `laborCostShare` | 0.2–0.95 | Fraction of the service's price that is human labor |
| `complementarity` | 1–4× | How much AI speeds up the tasks the human *keeps* |
| `hiringAdjustmentYears` | 0.5–5 | Years for the workforce to grow (credential/training friction) |
| `demandAbsorptionYears` | 1–8 | Years for the market to respond to a price change |
| `supportFraction` | 0–0.8 | Share of the job that is support work (admin, marketing, editing) rather than the core skill |
| `reachCeiling` | 0–20 | Extra multiples of output one human can serve once support is offloaded (high for broadcastable work) |
| `robotArrivalYear` | 0–30 | *Hand only:* years until dexterous robots meaningfully deploy |
| `robotRampYears` | 1–15 | *Hand only:* how long deployment takes to spread |

Claude also returns four short narratives shown in the UI (`rationale`, `commentary`,
`elasticityNote`, `incomeNote`), anchored where possible to BLS 2023–33 employment
projections.

A few values are set by the app, not estimated: `supportAICost = 0.04` (support work is
software-cheap for every job), the heart-core ceiling of 0, and for hand jobs a fixed
slow embodied-AI curve (3% today → 12% at year 5) — the robot-arrival slider, not the
capability curve, is the user's control there.

## Phase 2 — The math

The simulation runs 360 steps over 30 years, so the step is
$\text{timeStep} = \tfrac{30}{360} = \tfrac{1}{12}$ year. Each step has two parts: a
**static equilibrium** (given the moment's AI capability, what do cost, demand, and wages
*want* to be?) and **lagged dynamics** (the market and workforce move toward those
targets slowly). All quantities are indexed so year 0 equals 1.0 (displayed as 100), then
scaled by the BLS anchors.

### Step 0 — Curves fixed at estimation time

**AI capability** follows a Gompertz curve through two user-controlled anchor points —
the share of tasks AI can do *today* ($\text{todayShare}$) and *in 5 years*
($\text{fiveYearShare}$), the two slider handles:

$$A(t) = e^{-\,\text{shape}\;\cdot\; e^{-\,\text{rate}\,\cdot\, t}}$$

$$\text{shape} = -\ln(\text{todayShare}) \qquad
\text{rate} = -\tfrac{1}{5}\,\ln\!\left(\frac{\ln \text{fiveYearShare}}{\ln \text{todayShare}}\right)$$

Gompertz gives the characteristic S-curve: slow start, steep middle, saturating tail.

**The robot gate** (hand jobs only) is a logistic centered on the arrival year —
capability in the lab is worthless until machines actually deploy:

$$D(t) = \frac{1}{1 + e^{-\,\text{steepness}\,(t - \text{robotArrivalYear})}}
\qquad \text{steepness} = \frac{4}{\text{robotRampYears}}$$

For mind and heart work $D(t) = 1$. **Realized core capability** is the brain curve
through the gate, capped by the work-kind ceiling (0 for heart):

$$\text{capability}(t) = \min\bigl(A(t)\cdot D(t),\ \text{ceiling}\bigr)$$

**Everything ramps from today's baseline** so year 0 shows no artificial shock. A ramp
progress variable rebases the capability gain to zero at $t=0$:

$$\text{rampProgress}(t) = \frac{\text{capability}(t) - \text{capability}(0)}{1 - \text{capability}(0)}$$

and drives productivity and complementarity linearly from their today values to their
ceilings:

$$\text{productivity}(t) = \text{productivityToday} + (\text{productivityCeiling} - \text{productivityToday})\cdot \text{rampProgress}(t)$$

$$\text{complementarity}(t) = 1 + (\text{complementarityCeiling} - 1)\cdot \text{rampProgress}(t)$$

**AI cost** decays exponentially:

$$\text{aiCost}(t) = \text{aiCostToday}\cdot(1 - \text{aiCostDecayRate})^{\,t}$$

**Support automation** runs on its own fast software curve for every job (≈15% today,
≈50% by year 3, saturating near 95%):

$$\text{supportAuto}(t) = e^{-\ln(1/0.15)\,\cdot\, e^{-0.30\, t}}$$

and as support is offloaded, **reach** grows from 1.0 toward $1 + \text{reachCeiling}$
along that curve:

$$\text{reachGain}(t) = 1 + \text{reachCeiling}\cdot
\frac{\text{supportAuto}(t) - \text{supportAuto}(0)}{1 - \text{supportAuto}(0)}$$

### Step 1 — Static equilibrium at time $t$

The unit of analysis is *one unit of output* (one repair, one case, one performance),
split into core work (share $1 - \text{supportFraction}$) and support work (share
$\text{supportFraction}$). Writing $a = \text{capability}(t)$,
$C = \text{complementarity}(t)$, $s = \text{supportAuto}(t)$:

$$\text{humanCorePerUnit} = (1 - \text{supportFraction})\cdot\frac{1 - a}{C}$$

$$\text{aiCorePerUnit} = (1 - \text{supportFraction})\cdot a\cdot\frac{\text{aiCost}}{\text{productivity}}$$

$$\text{humanSupportPerUnit} = \text{supportFraction}\cdot\frac{1 - s}{C}
\qquad
\text{aiSupportPerUnit} = \text{supportFraction}\cdot s\cdot \text{supportAICost}$$

The first line is the heart of the model: $\text{humanCorePerUnit}$ is **human labor per
unit of output** — it drives employment — while the AI terms carry cost but no headcount.

**Cost, price, and the demand response:**

$$\text{costPerUnit} = \frac{\text{humanCorePerUnit} + \text{aiCorePerUnit}}{\text{reachGain}}
+ \text{humanSupportPerUnit} + \text{aiSupportPerUnit}$$

$$\text{priceChange} = \text{laborCostShare}\cdot(\text{costPerUnit} - 1)$$

$$\text{marketTarget} = (1 + \text{priceChange})^{-\,\text{demandElasticity}}$$

As AI cheapens production, $\text{costPerUnit}$ falls below 1, price falls, and the
market *wants* to expand by the elasticity power law. This is the engine that lets
employment **rise** even as automation climbs — when demand grows faster than
labor-per-unit shrinks.

**Wage per worker** (an index; two opposing forces):

$$\text{wageValue} = \underbrace{\text{leverage}\cdot(1 - a)}_{\text{human-exclusive share at full rate}}
\;+\; \underbrace{\text{leverage}\cdot a\cdot \text{aiFloor}}_{\text{contested share repriced to AI cost}}$$

$$\text{leverage} = C\cdot \text{reachGain} \qquad
\text{aiFloor} = \frac{\text{aiCost}}{\text{productivity}}$$

The first term is the human-exclusive share of the job, scaled up by leverage (AI
assistance plus offloaded support make each remaining human responsible for more value).
The second term is a *price anchor*, not payment for work performed: on the automated
share, the buyer's alternative is AI at cost $\text{aiFloor}$, so the value the human
used to capture from that part of the job's bundle is competed down to the AI's price —
but never below it, which is why an expensive robot props wages up even at high
capability. Early on, leverage dominates and wages rise; at high capability the floor
dominates and wages compress toward it.

### Step 2 — Dynamics: from $t$ to $t + \text{timeStep}$

Real markets and workforces don't jump to equilibrium. Two state variables — market size
$M$ and employment $E$, both starting at 1 — chase their targets with first-order lags:

$$M(t + \text{timeStep}) = M(t) + \frac{\text{marketTarget}(t) - M(t)}{\text{demandAbsorptionYears}}\cdot \text{timeStep}$$

$$\text{employmentTarget}(t) = M(t)\cdot\frac{\text{humanCorePerUnit}(t)}{\text{humanCorePerUnit}(0)}$$

$$E(t + \text{timeStep}) = E(t) + \frac{\text{employmentTarget}(t) - E(t)}{\text{laborAdjustmentYears}}\cdot \text{timeStep}$$

where $\text{laborAdjustmentYears} = \text{hiringAdjustmentYears}$ when the workforce is
growing, but a fast fixed $0.75$ years when shrinking — layoffs are quicker than
credentialing. Note that $\text{employmentTarget}$ uses the *lagged* market, so shocks
propagate down a chain: capability → cost → price → demand → market (lag 1) →
employment (lag 2).

**The scarcity premium** closes the loop between those lags and pay. When demand outruns
the workforce, the workers already in the job capture a transient premium:

$$\text{employmentGap}(t) = \operatorname{clamp}\!\left(\frac{\text{employmentTarget}(t) - E(t)}{E(t)},\ -0.5,\ +0.5\right)$$

$$\text{incomeIndex}(t) = \frac{\text{wageValue}(t)}{\text{wageValue}(0)}\cdot
\bigl(1 + \text{scarcityPremiumSensitivity}\cdot \text{employmentGap}(t)\bigr)$$

with $\text{scarcityPremiumSensitivity} = 0.5$ (a 10% labor shortage lifts pay 5%). The
premium is self-extinguishing — as $E$ catches up, the gap closes and income settles back
to the productivity-driven path. A negative gap (a glut during contraction) pushes income
below it. This is why the demand-elasticity slider visibly moves the income chart: more
elasticity → bigger expansion → wider gap → larger transient premium.

**Finally**, the indexed series are scaled to real units: employment × the BLS headcount,
income × the BLS-anchored wage (or left as an index of 100 = today when BLS has no wage
for the occupation).

### Reading the charts

Employment falling while income rises means substitution is winning on headcount but
survivors are leveraged. Both rising means market expansion dominates (elastic demand,
cheap AI). An income hump in the middle years is the scarcity premium at work. A heart
job grows along the demand curve with income nearly flat — its core can't be automated,
so AI only cuts its support costs.

---

## Tuning

In `netlify/functions/estimate.mjs`:
- **Model**: the `model: "claude-sonnet-4-6"` lines (one per branch).
- **Rate limit**: the `RATE_LIMIT` constant (default 30/min).
- **System prompts**: `SOC_SYS` and `PARAMS_SYS` — calibration anchors live in `PARAMS_SYS`.

In `public/index.html`:
- Simulation constants (`simulationSteps`, `anchorYear`, `layoffAdjustmentYears`) sit near
  the top of the model `<script>` block.
- **`SCARCITY_PREMIUM_SENSITIVITY`** (default 0.5) sets how strongly a labor shortage lifts wages.
- The BLS catalog lives in the `OCC` array.

## Data

Employment and wage figures come from the US Bureau of Labor Statistics Occupational
Employment and Wage Statistics (OEWS) program — public-domain data.

## Troubleshooting

- **"Couldn't estimate that one"**: check the function logs (Logs → Functions →
  `estimate`) — the error line names the profession and cause. If it's credentials,
  enable AI Gateway or set `ANTHROPIC_API_KEY`; if it's Netlify credits, see
  Usage & billing → Account usage insights → AI inference.
- **"Too many lookups"**: per-IP rate limit hit. Wait a minute or raise `RATE_LIMIT`.
