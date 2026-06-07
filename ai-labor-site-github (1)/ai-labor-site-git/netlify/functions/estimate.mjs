import Anthropic from "@anthropic-ai/sdk";
import { getStore } from "@netlify/blobs";

// Netlify AI Gateway auto-injects ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL.
const anthropic = new Anthropic();

// Call the model with one automatic retry on transient failures (5xx, overloaded,
// network blips). A short backoff lets a momentary Gateway hiccup clear itself.
async function createWithRetry(params, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await anthropic.messages.create(params);
    } catch (e) {
      lastErr = e;
      const status = e?.status ?? e?.statusCode;
      const retryable = status === undefined || status >= 500 || status === 429;
      if (i < attempts - 1 && retryable) {
        await new Promise((r) => setTimeout(r, 600 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

const RATE_LIMIT = 30;          // requests per IP per minute
const RATE_WINDOW_MS = 60_000;

async function checkRateLimit(ip) {
  try {
    const store = getStore("rate-limits");
    const now = Date.now();
    const raw = await store.get(ip, { type: "json" });
    let hits = (raw?.hits || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (hits.length >= RATE_LIMIT) return false;
    hits.push(now);
    await store.setJSON(ip, { hits });
    return true;
  } catch {
    return true;
  }
}

const normalize = (s) => s.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 80);

async function getCached(bucket, key) {
  try {
    const store = getStore(bucket);
    return await store.get(key, { type: "json" });
  } catch {
    return null;
  }
}
async function setCached(bucket, key, value) {
  try {
    const store = getStore(bucket);
    await store.setJSON(key, value);
  } catch {}
}

// ---- System prompts ----

const SOC_SYS = `You map a user's free-text profession to matching SOC detailed occupation code(s) from the BLS catalog provided, then optionally give a finer-grained estimate.

RULES:
1. Pick one or more SOC codes whose union BEST represents what the user typed. Prefer narrow detailed codes over broad bucket codes when a clean match exists.
2. If the typed profession is clearly a SUBSET of the SOC bucket (e.g. "pediatric nurse" within "Registered Nurses", "tax accountant" within "Accountants and Auditors", "kindergarten teacher" within "Elementary School Teachers"), return BOTH the SOC code AND an "adjusted_estimate" — your best guess of US employment for the specific profession, which must be LESS than the BLS total for that code.
3. If the user-typed profession IS the SOC bucket as commonly understood (e.g. "plumber" ≈ Plumbers/Pipefitters/Steamfitters, "lawyer" ≈ Lawyers, "registered nurse" ≈ Registered Nurses), return the SOC codes only and OMIT adjusted_estimate (the app uses the BLS total).
4. NEVER return an adjusted_estimate larger than the sum of the matched SOC codes' employment. Be conservative — when unsure, omit it and rely on the SOC total.
5. "confidence" = one of: exact | medium | low | very low. Reserve "exact" for clean whole-bucket matches only. Use "very low" when you're essentially guessing the split.
6. If BLS does not track the profession at all (podcaster, influencer), return "codes":[] and explain in "basis"; omit adjusted_estimate.
7. WAGES: the app computes the exact employment-weighted median annual wage of the summed codes (the "anchor wage"). Optionally provide "adjusted_wage" = your estimate of the typical annual wage for the SPECIFIC profession, IF it would differ materially from the bucket average (e.g. pipefitters tend to out-earn the plumbing bucket; pediatric vs. general nurses differ less). Set "adjusted_wage" only when you have a concrete reason it diverges; otherwise omit it and the app shows the bucket wage as-is. When given, add one sentence to "wage_basis" explaining the direction and rough size of the difference. Do not invent precision — round to the nearest 1000.

Respond with ONLY a JSON object, no markdown, no prose:
{"codes":["47-2152"],"adjusted_estimate":155000,"confidence":"low","basis":"<one sentence>","adjusted_wage":72000,"wage_basis":"<one sentence, omit if no adjustment>"}`;

const PARAMS_SYS = `You estimate parameters for an economic model of how AI affects employment in a given profession. You must respond with ONLY a JSON object, no prose, no markdown fences.

Estimate these parameters:

1. "currentAutomatable" (number, 0.01-0.60): The share of this job's tasks that today's best AI can already do, right now, in 2026. Be realistic — for most jobs this is modest (0.05-0.35).
2. "productivityToday" (number, 1-30): How many times faster than a human AI is TODAY at the tasks it can already do. Software/text: often 5-20×. Physical work: 1-3×.
3. "productivityCeiling" (number, 2-100): How many times faster AI EVENTUALLY gets at the automatable tasks. HIGH (50-100) for pure knowledge/software work; MODERATE (3-8) for physical work bounded by real-world execution speed; LOW (1-2) for work where humans are strongly preferred. Must be >= productivityToday.
4. "aiCostToday" (number, 0.02-1.0): Cost of an AI hour as a fraction of a human hour today. LOW (0.03-0.10) for software-only work; MID (0.10-0.30) for robotics/physical; 1.0 if humans are essentially irreplaceable.
5. "aiCostDecayRate" (number, 0.0-0.45): Annual % drop in that AI cost. HIGH (0.35-0.45) for software; LOW (0.05-0.15) for robotics/actuators; 0 if irreplaceable.
6. "demandElasticity" (number, 0.0-4.0): Long-run % demand growth per 1% price drop. LOW (0.3-0.8) inelastic; HIGH (1.5-3.0) elastic.
7. "laborCostShare" (number, 0.2-0.95): Fraction of the service's price that is human labor.
8. "complementarity" (number, 1.0-4.0): How much AI speeds up the HUMAN-only tasks the worker keeps doing. For MIND work this can be substantial (1.3-2.0): AI drafts, researches, reviews. For HAND work it must be very conservative (1.0-1.15): you cannot AI-accelerate crawling under a sink or suturing tissue — the physical act runs at human speed. For HEART work, 1.0.
9. "hiringAdjustmentYears" (number, 0.5-5.0): Years for the workforce to GROW (credential barrier).
10. "demandAbsorptionYears" (number, 1.0-8.0): Years for the market to absorb a price drop.

EVERY job has support work (marketing, admin, scheduling, editing, billing, logistics, outreach) that AI automates cheaply and early — software, no robot needed. This matters most for HEART work, whose core (a human people want) is untouchable but whose support wrapper collapses in cost, freeing the human to reach a bigger audience.
11. "supportFraction" (number, 0.0-0.8): Share of the job that is automatable SUPPORT work rather than the core skill. Influencer/creator/performer: HIGH (0.4-0.7) — much of the grind is editing, promotion, brand admin. Surgeon/plumber: LOW (0.1-0.3) — mostly core. Knowledge worker: MID-HIGH.
12. "reachCeiling" (number, 0.0-20.0): As support is offloaded, how many ADDITIONAL multiples of core output one human can serve. Scalable/broadcastable work (influencer, online coach, recording artist): HIGH (5-20) — one person reaches vastly more. Inherently 1-to-1 work (surgeon, wedding officiant, in-home plumber): LOW (0-1) — you still serve one client at a time.

For HAND work only, the robotics gate (physical capability needs capable, affordable, dexterous robots to exist and deploy):
13. "robotArrivalYear" (number, 0-30): Years until such robots reach meaningful deployment for THIS job. Simple structured tasks sooner (5-12); dexterous/unstructured/high-stakes/trust-sensitive later (12-30).
14. "robotRampYears" (number, 1-15): Once arrived, years for deployment to spread.
(For MIND and HEART work, return robotArrivalYear: 0 and robotRampYears: 1.)

Also return:
- "workKind" (string): "mind", "hand", or "heart". Choose "heart" whenever the thing being sold is fundamentally a HUMAN doing it live or in person and audiences/clients specifically want a human: ALL performing musicians and instrumentalists (violinist, pianist, singer, orchestra player), actors, dancers, comedians, athletes, live entertainers, influencers/creators, clergy, and therapists/coaches where presence is the point. A violinist is HEART, not hand — the bowing technique is a skill, but people pay to hear a human perform, and a machine playing the notes is not a substitute for the concert. Use "hand" only for physical work where the OUTPUT (a fixed pipe, a healed patient) is what's wanted and a competent machine would be an acceptable substitute. Use "mind" for knowledge/analysis/language/code.
- "confidence" (string): "high", "medium", or "low".
- "rationale" (string, max 200 chars): one sentence on the key dynamic. Where possible, ANCHOR to BLS 2023-33 employment projections (all-occupations baseline is +4.0%/decade; healthcare/personal-care aides ~+20%; office/admin support declining due to AI) and name BLS if you use it.
- "commentary" (string, max 240 chars): a vivid one-sentence narrative of how the transition plays out.
- "elasticityNote" (string, max 200 chars): one sentence explaining WHY this profession's demand elasticity is high or low — what about this market makes buyers respond a lot (or little) to a price drop. Name the concrete mechanism (e.g. latent unmet demand, regulatory/insurance caps, discretionary vs. essential, fixed need per person).
- "incomeNote" (string, max 200 chars): one sentence explaining the projected path of average income per worker for this profession — WHY it rises, holds, or falls. Tie it to the model's forces: AI as a complement raising the productivity (and pay) of remaining workers vs. AI as a substitute compressing wages, plus whether market expansion or contraction dominates. Be concrete to this job.

CALIBRATION ANCHORS:
- Software engineer: {"workKind":"mind","currentAutomatable":0.30,"productivityToday":12,"productivityCeiling":100,"aiCostToday":0.05,"aiCostDecayRate":0.40,"demandElasticity":2.2,"laborCostShare":0.80,"complementarity":1.8,"hiringAdjustmentYears":0.8,"demandAbsorptionYears":3.0,"supportFraction":0.30,"reachCeiling":2,"robotArrivalYear":0,"robotRampYears":1}
- Lawyer: {"workKind":"mind","currentAutomatable":0.20,"productivityToday":8,"productivityCeiling":60,"aiCostToday":0.06,"aiCostDecayRate":0.38,"demandElasticity":0.6,"laborCostShare":0.78,"complementarity":1.5,"hiringAdjustmentYears":3.0,"demandAbsorptionYears":5.0,"supportFraction":0.35,"reachCeiling":1.5,"robotArrivalYear":0,"robotRampYears":1}
- Tax accountant: {"workKind":"mind","currentAutomatable":0.25,"productivityToday":10,"productivityCeiling":70,"aiCostToday":0.05,"aiCostDecayRate":0.40,"demandElasticity":0.3,"laborCostShare":0.70,"complementarity":1.2,"hiringAdjustmentYears":2.5,"demandAbsorptionYears":6.0,"supportFraction":0.40,"reachCeiling":1.5,"robotArrivalYear":0,"robotRampYears":1}
- Plumber: {"workKind":"hand","currentAutomatable":0.05,"productivityToday":1.3,"productivityCeiling":4,"aiCostToday":0.30,"aiCostDecayRate":0.08,"demandElasticity":1.4,"laborCostShare":0.70,"complementarity":1.05,"hiringAdjustmentYears":1.5,"demandAbsorptionYears":2.5,"supportFraction":0.20,"reachCeiling":0.5,"robotArrivalYear":15,"robotRampYears":10}
- Surgeon: {"workKind":"hand","currentAutomatable":0.08,"productivityToday":1.3,"productivityCeiling":3,"aiCostToday":0.40,"aiCostDecayRate":0.07,"demandElasticity":0.7,"laborCostShare":0.65,"complementarity":1.1,"hiringAdjustmentYears":4.5,"demandAbsorptionYears":6.0,"supportFraction":0.15,"reachCeiling":0.3,"robotArrivalYear":20,"robotRampYears":12}
- Warehouse picker: {"workKind":"hand","currentAutomatable":0.10,"productivityToday":1.5,"productivityCeiling":6,"aiCostToday":0.20,"aiCostDecayRate":0.12,"demandElasticity":1.0,"laborCostShare":0.55,"complementarity":1.05,"hiringAdjustmentYears":0.8,"demandAbsorptionYears":2.0,"supportFraction":0.10,"reachCeiling":0.2,"robotArrivalYear":6,"robotRampYears":6}
- Live musician: {"workKind":"heart","currentAutomatable":0.02,"productivityToday":1.1,"productivityCeiling":1.2,"aiCostToday":1.0,"aiCostDecayRate":0.0,"demandElasticity":1.2,"laborCostShare":0.85,"complementarity":1.0,"hiringAdjustmentYears":0.8,"demandAbsorptionYears":3.0,"supportFraction":0.40,"reachCeiling":4,"robotArrivalYear":0,"robotRampYears":1}
- Violinist / concert performer: {"workKind":"heart","currentAutomatable":0.02,"productivityToday":1.1,"productivityCeiling":1.2,"aiCostToday":1.0,"aiCostDecayRate":0.0,"demandElasticity":0.9,"laborCostShare":0.88,"complementarity":1.0,"hiringAdjustmentYears":1.5,"demandAbsorptionYears":3.0,"supportFraction":0.30,"reachCeiling":3,"robotArrivalYear":0,"robotRampYears":1}
- Influencer / content creator: {"workKind":"heart","currentAutomatable":0.03,"productivityToday":1.2,"productivityCeiling":1.5,"aiCostToday":1.0,"aiCostDecayRate":0.0,"demandElasticity":1.8,"laborCostShare":0.85,"complementarity":1.0,"hiringAdjustmentYears":0.5,"demandAbsorptionYears":2.0,"supportFraction":0.60,"reachCeiling":12,"robotArrivalYear":0,"robotRampYears":1}

If the input is not a recognizable profession, return {"error":"not_a_profession"}.`;

// Parse a Claude response (text content blocks) into the JSON object it contains.
// Thinking/reasoning blocks are ignored — only text blocks are considered.
function parseJsonReply(msg) {
  let text = (msg.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("no_json_in_reply (stop_reason=" + (msg.stop_reason || "?") + ", text_len=" + text.length + ")");
  }
  text = match[0].replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  return JSON.parse(text);
}

export default async (req, context) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers });
  if (req.method !== "POST")
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers });

  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || "unknown";
  if (!(await checkRateLimit(ip)))
    return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers });

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad_request" }), { status: 400, headers });
  }
  const profession = body?.profession;
  const type = body?.type;
  if (typeof profession !== "string" || profession.trim().length < 2 || profession.length > 80)
    return new Response(JSON.stringify({ error: "invalid_profession" }), { status: 400, headers });
  if (type !== "bls" && type !== "params")
    return new Response(JSON.stringify({ error: "bad_request" }), { status: 400, headers });

  const key = normalize(profession);

  // ------- BLS lookup branch -------
  if (type === "bls") {
    const catalog = body?.catalog;
    if (typeof catalog !== "string" || catalog.length < 100 || catalog.length > 200_000)
      return new Response(JSON.stringify({ error: "bad_request" }), { status: 400, headers });

    const cached = await getCached("bls-cache", key);
    if (cached) return new Response(JSON.stringify({ ...cached, cached: true }), { status: 200, headers });

    let parsed;
    try {
      const msg = await createWithRetry({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        system: SOC_SYS,
        messages: [{ role: "user", content: "CATALOG (code<TAB>title):\n" + catalog + "\n\nUSER PROFESSION: " + profession }],
      });
      if (msg.stop_reason === "max_tokens") {
        console.error("[bls] truncated for profession:", profession, "stop_reason=max_tokens");
        return new Response(
          JSON.stringify({ error: "lookup_failed", detail: "response_truncated" }),
          { status: 502, headers }
        );
      }
      parsed = parseJsonReply(msg);
    } catch (e) {
      console.error("[bls] error for profession:", profession, "→", String(e));
      return new Response(
        JSON.stringify({ error: "lookup_failed", detail: String(e).slice(0, 160) }),
        { status: 502, headers }
      );
    }

    await setCached("bls-cache", key, parsed);
    return new Response(JSON.stringify(parsed), { status: 200, headers });
  }

  // ------- Parameter estimation branch -------
  const cached = await getCached("params-cache", key);
  if (cached) return new Response(JSON.stringify({ ...cached, cached: true }), { status: 200, headers });

  let parsed;
  try {
    const msg = await createWithRetry({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      system: PARAMS_SYS,
      messages: [{ role: "user", content: `Profession: ${profession}` }],
    });
    // If the model ran out of tokens, the JSON will be truncated — surface that explicitly.
    if (msg.stop_reason === "max_tokens") {
      console.error("[params] truncated for profession:", profession, "stop_reason=max_tokens");
      return new Response(
        JSON.stringify({ error: "estimation_failed", detail: "response_truncated" }),
        { status: 502, headers }
      );
    }
    parsed = parseJsonReply(msg);
  } catch (e) {
    console.error("[params] error for profession:", profession, "→", String(e));
    return new Response(
      JSON.stringify({ error: "estimation_failed", detail: String(e).slice(0, 160) }),
      { status: 502, headers }
    );
  }

  if (parsed?.error === "not_a_profession")
    return new Response(JSON.stringify(parsed), { status: 200, headers });

  await setCached("params-cache", key, parsed);
  return new Response(JSON.stringify(parsed), { status: 200, headers });
};

export const config = { path: "/api/estimate" };
