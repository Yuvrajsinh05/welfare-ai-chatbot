# How the welfare assistant works, module by module

## The one idea behind the design

**The model proposes; the server decides.** Gemini reads the message and proposes a triage (category, urgency, safeguarding, disposition) and a reply. That proposal is treated as untrusted input: it is validated against a schema and then passed through `policy.ts`, which enforces the house rules in code. Local safety rules run on every message and can only *raise* the level of care, never lower it. So the app stays safe when the model is wrong, manipulated, slow or down.

```
Browser ──POST /api/chat──▶ route.ts ──▶ conversation-service.ts
                                           │ 1. reserve turn (short DB transaction)
                                           │ 2. model.ts  ──▶ Gemini (no transaction open)
                                           │ 3. policy.ts (schema check + house rules)
                                           │ 4. save turn + case together (one transaction)
                                           ▼
                                      PostgreSQL ◀── staff-service.ts ◀── /api/staff/* ◀── Staff dashboard
```

---

## 1. `db/001-initial.sql`: data model

Three tables:

| Table | One row per | Key points |
|---|---|---|
| `conversations` | student session | `session_hash` = SHA-256 of the cookie token (a DB leak can't hijack sessions). Optional `name`, `email`. |
| `turns` | student message + assistant reply | `decision` (JSONB) holds the final triage, the reply, the `reason`, and `audit` (the raw model proposal, provider status, attempts). `request_id` is unique per conversation, which makes retries safe. |
| `cases` | escalation | `status` new → in_progress → resolved. A CHECK constraint ties status to ownership (`new` has no owner; others must have one). |

Two partial unique indexes do real work:
- `one_pending_turn`: at most one in-flight turn per conversation, so replies can't interleave.
- `one_active_case`: at most one open case per conversation. Further escalations update it instead of flooding the queue.

**Why JSONB for the decision?** The triage shape will evolve; the queue only filters on the `cases` columns, which are real typed columns.

## 2. `src/lib/db.ts`: connection pool

One `pg` pool per server instance, cached on `globalThis` (dev hot-reload would otherwise create a new pool each edit). `max: 3` because on Vercel every function instance has its own pool. In production use Neon's `-pooler` URL. `transaction()` wraps BEGIN/COMMIT/ROLLBACK.

**Rule:** never hold a transaction open across the AI call. Model calls take seconds; a held row lock would block the student's other requests and staff actions.

## 3. `src/lib/http.ts`: API boundary

- `HttpError(status, message)`: thrown anywhere, turned into JSON by `api()`.
- `readJson(request, zodSchema)`: size-limited body + Zod validation. Every route validates input this way.
- `api()`: unknown errors become a generic 503, so stack traces and SQL never reach the browser.

## 4. `src/lib/auth.ts`: sessions

- **Student:** anonymous. First visit creates a conversation and sets an HTTP-only cookie with a random 32-byte token. The browser can't read it (XSS-safe); the DB stores only its hash.
- **Staff:** demo accounts `alex` / `bea` with passwords from env. Cookie = base64 payload `{id, expires}` + HMAC signature with `SESSION_SECRET`. The server verifies the signature on every staff request, so the acting staff id comes from the server, never from the request body.
- `checkOrigin()`: CSRF guard on every state-changing request; with `SameSite=strict` cookies this is defence in depth.
- `timingSafeEqual`: password/signature comparison doesn't leak timing information.

## 5. `src/data/knowledge-base.json` + `src/lib/catalogue.ts`: the knowledge base

The 13 resources from the brief, word for word. **No retrieval/search:** the whole KB is ~3.5k tokens, so every model call gets all of it. With 13 entries, keyword or vector search only adds ways to miss the right entry. *When would I add retrieval?* Hundreds of entries, or per-organisation KBs: embeddings + pgvector, top-k entries.

`resourceCards(ids)` turns the ids the model cited into the cards under a reply. The UI shows links from our data, never from model text.

## 6. `src/lib/safety.ts`: local safety signals (model-independent)

`riskSignals(text)` returns `{ danger, risk }` from regex lists:
- **danger**: explicit phrases ("want to die", "kill myself", "can't keep myself safe"…) or the *withdrawal + hopelessness* pattern (message 1 in the brief).
- **risk**: harassment, self-harm, worsening mental health, "can't cope"… → needs a person, not necessarily an emergency.

Also used **in the browser**, so the 999/Samaritans banner appears the moment a student types or sends such a message, before the server answers.

**Honest limit:** regex can't understand paraphrase. That's the model's job (it can also set `possibleImmediateDanger`). The two layers are OR-ed: either one alone escalates.

## 7. `src/lib/triage-schema.ts`: the contract with the model

A strict Zod schema: `category`, `urgency`, `safeguarding`, `disposition` (the four the brief requires) plus `possibleImmediateDanger`, `humanReason`, `messageKind`, `reply`, `summary`, `factIds`. `.strict()` rejects extra fields.

**Deliberately missing:** any field for case status or owner. Even a fully manipulated model has no way to express "resolve this case".

The same schema is sent to Gemini as `responseJsonSchema` (structured output), so the model is constrained *and* the result is re-validated.

## 8. `src/lib/model.ts`: the AI call

- Sends system instructions + `{ approvedGuidance, dialogue (last 3 turns), latestStudentMessage }`. Emails and phone numbers are redacted first.
- Student text goes in as **data inside JSON**, and the prompt says it is never instructions. That's the first injection defence; `policy.ts` is the one that's actually enforced.
- **Two attempts, 9s each.** On timeout, 429, 5xx or invalid JSON the second attempt goes to `GEMINI_FALLBACK_MODEL`. A 503 means *that model* is overloaded; a different model has separate capacity and quota, so switching rescues far more calls than retrying the same one. Never throws; failure returns `raw: null` + a status. The model that answered is saved in the audit.
- Models: `gemini-3.5-flash`, falling back to `gemini-3.5-flash-lite`. Measured: the preview `gemini-3.1-flash-lite` returned 503 on every call at test time.
- `messageKind: chat` covers greetings, thanks, "how do I use you?" and "any update on my case?": short natural replies with no source needed.

## 9. `src/lib/policy.ts`: house rules in code (the core)

`applyPolicy(text, rawModelOutput, clarificationCount)` validates the proposal, then applies rules in order. **The first match wins:**

| # | Rule | Triggered by | Outcome |
|---|---|---|---|
| 1 | Possible immediate danger | local `danger` OR model `possibleImmediateDanger`/`critical` | escalate, critical, safeguarding; medical → "call 999 for an ambulance", crisis → 999 + Samaritans with caring wording |
| 2 | Crisis / risk | local `risk` OR model `safeguarding`/`risk` | escalate, ≥ high, safeguarding; keeps the model's checked guidance |
| 3 | Immigration | local regex OR model category | escalate, fixed wording + GOV.UK card (no model interpretation of visa rules) |
| 4 | Individual legal dispute | deposit dispute, court, eviction… | escalate, keeps checked *general* guidance |
| 5 | Model unavailable/invalid (both models) | schema failed | obvious spam → ignored; else escalate, honest "I'd rather not guess" + likely resource card; urgency from the words, not the outage |
| 6 | Spam / abuse / injection | model `messageKind`, local injection regex | ignored; manipulation + real need → escalate |
| 7 | Model says a person is needed | `disposition=escalate` or any `humanReason` | escalate, keeping checked guidance |
| 8 | Routine | everything else | answer / clarify / chat if `checkedDraft` passes. **If it fails, no case:** point to the cited resource in our own words, or ask a clarifying question |

**When is a staff case created?** Only for real need (rules 1–4, 7), a full model outage (5), or after two vague turns in a row. A failed wording check on a routine message never creates one. That was the main reason the earlier version escalated so much.

Escalation wording says "I've added this to your existing request" when the conversation already has an open case, instead of announcing a new handoff every time. The case summary puts the newest, most serious item first.

`checkedDraft()` is the grounding gate for any model text shown to students:
- removes sentences where the model *claims* it escalated (the server writes that, only after saving), but keeps *offers* like "Shall I flag this?";
- rejects unknown source ids, URLs, money amounts, entitlement/visa verdicts, response-time promises, positive "guarantees";
- a substantive answer must cite a KB entry; a clarifying question must contain 1–3 questions and stay under 500 characters; chat and short escalation acknowledgements need no source.

Escalation replies always end with: *"I've passed this to the student support team, and a member of staff will follow up with you."*

**Staff summary:** the model's summary if the model itself said escalate; if the server overruled the model, the student's own words. A model that thought a crisis was "a library question" must not write the crisis summary.

**Probe question to expect:** *"Why not just trust the prompt?"* Because prompts are suggestions; injection, model updates and outages all bypass them. Code can't be talked out of a rule.

## 10. `src/lib/conversation-service.ts`: one turn, end to end

1. **Reserve** (short transaction, locks the conversation row):
   - recover any turn stuck `pending` > 45s (crashed request) → escalated, never lost;
   - same `requestId` already saved → return it (the browser's retry after a dropped connection);
   - **crisis message** → save the safe decision **and** the critical case right now, before any model call; the model is asked afterwards (`auditCrisisTurn`, run via `after()`), only to record its view;
   - otherwise insert a `pending` turn.
2. **Context**: last 3 completed turns; count consecutive clarifications (limit 2).
3. **Model → policy** (no transaction open). The raw proposal is stored as `decision.audit`.
4. **Save** the turn and, if escalated, `upsertCase()` in one transaction. Urgency and safeguarding only ever go **up** on an open case; ownership is never touched.

If an escalated student hasn't given name/email, the reply asks for it, at the moment staff will need it.

## 11. `src/lib/staff-service.ts`: queue and claiming

**Ordering:** open before resolved → critical → safeguarding → urgency → unclaimed before claimed → oldest first.

**Claiming under concurrency** (brief item 6):
```sql
UPDATE cases SET claimed_by = $2, status = 'in_progress', ...
WHERE id = $1 AND status = 'new' AND claimed_by IS NULL
RETURNING *
```
PostgreSQL row-locks the case during an UPDATE. If Alex and Bea click at the same instant, Bea's UPDATE waits for Alex's to commit, re-checks the WHERE clause, finds `status = 'in_progress'`, updates 0 rows, and Bea gets **409 "already claimed by alex"**.
*Without it:* "SELECT status → if new → UPDATE" lets both read `new` before either writes. Both think they own the student. Proven by `npm run test:db` (two simultaneous claims → exactly one 200, one 409).

`resolveCase`: only the owner, and it locks the conversation so a new escalation can't slip in mid-resolution.

## 12. API routes: `src/app/api/**/route.ts`

| Route | Purpose | Auth |
|---|---|---|
| `POST /api/conversations` | start/restore conversation, return transcript | student cookie (creates one) |
| `PATCH /api/conversations` | save name + email | student cookie |
| `POST /api/chat` | send a message, get the saved reply | student cookie |
| `GET /api/staff/cases` | priority queue | staff cookie |
| `GET/PATCH /api/staff/cases/:id` | detail; `claim` / `resolve` | staff cookie |
| `GET/POST/DELETE /api/staff/session` | who am I / sign in / sign out | — |

Every route: Zod-validated input, `checkOrigin` on writes, `api()` wrapper. `maxDuration = 30` on `/api/chat` covers two model attempts.

## 13. Front end: `src/app/page.tsx`, `chat-composer.tsx`, `staff/page.tsx`

- **Student chat:** greeting, suggestions, transcript restored from the cookie, "Thinking…" while waiting, resource cards, "Passed to the support team" label on escalations, an emergency banner driven by local signals. A failed send restores the draft and **reuses its requestId**, so retrying can't create a duplicate case.
- **Composer:** Enter sends, Shift+Enter new line, IME-safe, auto-grows.
- **Staff dashboard:** sign-in, counts (open / critical / safeguarding), priority cards with badges, case view with summary, claim/resolve buttons and the full conversation with triage chips per message. Polls every 10 s.

## 14. Tests

| Command | What it proves | Model |
|---|---|---|
| `npm run probe` | the two required probes: injection never resolves or lowers priority; crisis always escalates to a human with 999/Samaritans | recorded, deliberately wrong proposals + "model down" |
| `npm test` | probes + 17 house-rule tests (danger without model, regulated advice, grounding gate, clarification, summaries) | recorded |
| `npm run test:db` | real Postgres: durable crisis case, retry idempotency, concurrent claim 1×200/1×409, no downgrade, abandoned-turn recovery | stub |
| `npm run test:http` | builds and starts the app; same checks through real HTTP + auth + origin checks | none |
| `npm run eval:model` | the 9 brief messages against live Gemini → `docs/model-evaluation.json` | **live** |
