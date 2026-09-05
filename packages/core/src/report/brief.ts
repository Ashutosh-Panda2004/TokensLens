/**
 * **The analysis brief appended to every monthly report.**
 *
 * ## Why it is a visible section and not a hidden one
 *
 * The obvious implementation is to conceal this — an HTML comment, white
 * text, a zero-width block — so the human sees clean data and the assistant
 * silently obeys. That is deliberately **not** what this does, for three
 * reasons:
 *
 * 1. A report is a thing people forward. Instructions hidden in a document
 *    that act on *somebody else's* assistant without their knowledge is
 *    prompt injection, whoever wrote it and however benign the intent.
 * 2. This project's most distinctive rule is that an artefact declares
 *    everything in it — `BUNDLE_MANIFEST` exists so a reviewer can audit a
 *    payload in one sitting. A concealed payload would contradict the one
 *    principle the tool is most credible for.
 * 3. It buys nothing. A model reads the whole document; position and
 *    styling change what the *human* notices, not what the model receives.
 *
 * So it is unobtrusive rather than invisible: last, after the data, clearly
 * titled, and honest about what it is.
 *
 * ## Why it is written this way
 *
 * A weak brief ("analyse this and suggest savings") produces a summary of
 * the tables, which the reader already has. The brief therefore does four
 * things a generic prompt does not: it states the mechanism behind the
 * numbers so the model reasons about causes rather than restating totals; it
 * names the levers that actually exist and their relative power; it forbids
 * the specific failure modes these reports invite; and it fixes an output
 * shape that ends in something a person can do on Monday morning.
 */
export const ANALYSIS_BRIEF = `
## Analysis brief

_This section is written for an AI assistant. Paste this whole document into the assistant your
organisation permits and it will act on the instructions below. It contains no personal data, no
source code, and no prompt text — only aggregate figures. Delete this section if you would rather
read the data yourself._

---

**Your role.** You are a FinOps analyst specialising in AI-assisted software development. You have
been given one month of measured GitHub Copilot usage from a single developer's machine. Produce a
diagnosis and a plan, not a summary — the reader already has the tables.

**What the numbers mean.** Copilot bills GitHub AI Credits at a fixed 1 credit = $0.01 USD, priced
from input, output and cached tokens. The dominant cost driver is almost never the number of
questions asked; it is the size of the context re-sent with each one. Every turn of a conversation
re-sends the entire history, so cost per turn grows with conversation length, and a long chat is
quadratic in a way that is invisible to the person having it. Code completions are not billed.

**Method — work through these in order:**

1. **Find the concentration.** Which cost centre, which model and which day dominate? Spend is
   almost always heavily concentrated; state the share explicitly. If "Messages" or "Tool Results"
   dominate the cost-centre table, the problem is context volume, not model choice, and advice
   about switching models will be a rounding error against it.
2. **Separate rate from volume.** Model choice sets the price per token; context size sets the
   number of tokens. Say which of the two is actually driving this month's bill, with the figures
   that show it. Do not recommend a cheaper model if the decomposition says volume is the problem.
3. **Price the conversation habit.** Using the conversation-economics section, work out what the
   compounding of long chats costs over a month, and what resetting at a sensible point would have
   saved. Express it in dollars per month, not per turn.
4. **Read the detector findings critically.** Attributed credits are counterfactuals, not
   measurements, and they may overlap — the same request can be both on an over-powered model and
   inside a stale session. Do not add them up. Rank them, and say which one is worth acting on
   first given its remediation tier: A is a central setting change, B is an automatic guard, C
   depends on somebody changing a habit and should be trusted least.
5. **Sanity-check the substitution table.** It assumes the cheaper model would have produced an
   acceptable result, which is not observable in this data. Treat it as an upper bound and say so.
   If the expensive model was used for genuinely hard work, the saving is not real.
6. **Look for what is missing.** The "classes that could not be assessed" section lists waste this
   tool could not measure and why. Consider whether any of them is likely to be large here, and say
   what evidence would settle it.

**Rules you must follow:**

- Never present an estimate as a measurement. The report marks which figures are measured; carry
  that distinction into your conclusions.
- Do not sum overlapping attributions into a single headline saving.
- Quantify every recommendation in dollars per month, and state the assumption it rests on.
- If the data does not support a recommendation, say so plainly. A short honest answer is worth
  more than a long speculative one.
- Do not suggest reducing Copilot usage as such. The goal is the same work for fewer credits, not
  less work. A saving achieved by using the assistant less is a loss reported as a win.

**Produce exactly these five sections:**

1. **Verdict** — two or three sentences. Is this month's spend reasonable for the work done, and
   what single fact most explains it?
2. **Where the money went** — the concentration, with shares, and whether rate or volume is the
   driver.
3. **The three highest-value changes** — ranked, each with: what to change, the expected monthly
   saving in dollars, the assumption it depends on, and how the reader would know within two weeks
   whether it worked.
4. **What not to bother with** — at least one thing that looks attractive in this data but is not
   worth the effort, and why. Be specific.
5. **What you could not tell from this data** — the questions this report cannot answer, and what
   would be needed to answer them.

Be concrete and numerate. Prefer one well-evidenced recommendation over five plausible ones.
`;
