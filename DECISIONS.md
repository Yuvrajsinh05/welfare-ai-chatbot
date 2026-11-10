# Decisions

## What I deliberately did not build

- **Retrieval.** The knowledge base is 13 entries (~3.5k tokens), so every call gets all of it. My first keyword search matched "example" to *exam* and stopped the model citing the right entry. Retrieval earns its place at hundreds of entries.
- **Streaming.** Every reply must pass the policy check before it's shown, so there is nothing safe to stream early. Emergency numbers don't wait: the browser shows them as soon as a dangerous message is typed.
- **Student accounts.** A cookie keeps the conversation; name and email are asked for in a panel and again on escalation. Registering before you can say you're in crisis is the wrong trade.
- **Paging, reassignment, multi-tenancy, SSO.** Paging on-call staff for critical cases is what I'd add first.

## A decision a reasonable engineer would make differently

I enforce the house rules with **deterministic code after a schema check**, not a second model call that reviews the first. A reviewer model would catch subtler problems (a sourced but misleading reply, paraphrased risk), but it doubles latency and cost, adds another thing that can fail or be manipulated, and is hard to test. My rules are readable and proven by `npm run probe`. The cost: regex only catches phrasings I thought of, so local signals can only *raise* risk and the model's danger flag is honoured too.

I also **retry once on a different model** before escalating. I first escalated immediately, then tried retrying the same model; measured runs showed 503s that only switching models rescued. A failed wording check on a routine message now falls back to pointing at the resource rather than creating a case.

## What would break first

The AI provider: on the free tier I saw 429 and 503 responses. Nothing unsafe happens, since the policy escalates and crisis messages are saved before the model is called, but a busy Monday would flood the queue with routine cases and bury urgent ones. I'd alert on the share of turns whose `audit.providerStatus` isn't `ok`, and on the age of the oldest unclaimed critical case.

## Where I overrode the AI tools

I built this with AI assistance, then audited it against the brief and changed what didn't hold up:
- It discarded the model's staff summary on every escalation and refused to tell students "a person will follow up", which the brief requires. Both fixed.
- It had built keyword retrieval and a fake "stream" that chopped a finished reply into chunks. I removed both.
- Its safety regex was tuned to the brief's crisis message; "I want to die" with the model down got no emergency numbers. I widened it and added tests for exactly that case.
- It had put real secrets in `.env.example`. Removed and rotated.
- It picked a preview model that returned 503 on every call when I measured it; I switched to a stable one.
