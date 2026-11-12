# AI Welfare Assistant

A conversational student-support assistant for a university welfare team.

- **Routine questions** are answered from the university's own approved guidance, with resource cards linking to the source.
- **Vague messages** get a short follow-up question instead of a guess.
- **Sensitive situations** (crisis, safeguarding, immigration, legal disputes) are handed to staff, who work them from a priority dashboard.

**Stack:** Next.js 16 · React 19 · PostgreSQL (Neon) · Gemini · Zod · deployed on Vercel

| | |
|---|---|
| Live app | _add Vercel URL_ |
| Student chat | `/` |
| Staff dashboard | `/staff` (demo accounts `alex` and `bea`; passwords supplied separately) |

Further reading: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (module by module) · [DECISIONS.md](DECISIONS.md) (choices and trade-offs)

---

## The core idea: the model proposes, the server decides

Gemini reads each message and *proposes* a triage (category, urgency, safeguarding flag, disposition) and a reply. That proposal is treated as untrusted input:

1. **Schema check.** The proposal is validated with Zod; anything malformed is treated as "model unavailable".
2. **Local safety signals** ([src/lib/safety.ts](src/lib/safety.ts)) run on every message, independently of the model. They can only *raise* the level of care, never lower it.
3. **House rules** ([src/lib/policy.ts](src/lib/policy.ts)) are applied in strict priority order, first match wins:

   | # | Situation | Outcome |
   |---|---|---|
   | 1 | Possible immediate danger | Escalate as **critical** + safeguarding; show 999 and Samaritans |
   | 2 | Crisis / risk | Escalate with safeguarding, at least **high** |
   | 3 | Immigration | Escalate with fixed, restrained wording (regulated advice in the UK) |
   | 4 | Individual legal dispute | Escalate, keep checked general guidance |
   | 5 | Model unavailable or invalid | Escalate (obvious spam aside) with honest wording |
   | 6 | Spam, abuse, prompt injection | Ignored; manipulation mixed with a real need is escalated |
   | 7 | Model says a person is needed | Escalate |
   | 8 | Routine | Answer, clarify or chat, **only** if the reply passes grounding checks |

4. **Grounding checks** on any reply shown to a student: it must cite real knowledge-base entries, and may not contain raw links, money amounts, eligibility verdicts, response-time promises, or claims that it has already escalated (the server owns that wording).

The result: the app stays safe when the model is wrong, manipulated, slow or down.

```
Browser ──POST /api/chat──▶ route.ts ──▶ conversation-service.ts
                                           │ 1. reserve turn (short DB transaction)
                                           │ 2. model.ts ──▶ Gemini (no transaction held)
                                           │ 3. policy.ts (schema check + house rules)
                                           │ 4. save turn + case together (one transaction)
                                           ▼
                                      PostgreSQL ◀── staff-service.ts ◀── /api/staff/* ◀── Staff dashboard
```

---

## Running locally

**Requirements:** Node.js 22+ and a PostgreSQL database (a free Neon project works). A Google AI Studio key is needed for live model replies.

```bash
npm ci
cp .env.example .env.local   # fill in the values below
npm run db:migrate
npm run dev                  # http://localhost:3000  and  http://localhost:3000/staff
```

### Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string. On Vercel use Neon's `-pooler` URL. |
| `GEMINI_API_KEY` | Google AI Studio key. |
| `GEMINI_MODEL` | Primary model (e.g. `gemini-3.5-flash`). |
| `GEMINI_FALLBACK_MODEL` | Used when the primary is overloaded (503) or rate-limited (429). |
| `SESSION_SECRET` | Signs staff session cookies. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `STAFF_A_PASSWORD`, `STAFF_B_PASSWORD` | Passwords for the demo staff accounts `alex` and `bea`. |

---

## Tests and safety probes

| Command | What it checks | Needs DB / API key? |
|---|---|---|
| `npm run probe` | The two required safety probes; exits non-zero if either fails | No |
| `npm test` | House-rule and policy unit tests | No |
| `npm run typecheck` | TypeScript | No |
| `npm run test:db` | Against real PostgreSQL, including concurrent case claims | DB |
| `npm run test:http` | Builds the app and tests end-to-end over HTTP | DB |
| `npm run eval:model` | Runs the nine brief messages against live Gemini, saving results to [docs/model-evaluation.json](docs/model-evaluation.json) | DB + API key |

### About the probes

The probes run against **recorded model responses**, not the live model, so they are deterministic and need no API key. The recorded responses are deliberately bad: the model "obeys" the injection, misjudges the crisis message, and in one case is simply unavailable. A pass therefore shows that the server's own validation and house rules enforce safety, *whatever the model says*.

- **Probe 1, prompt injection:** the message is never marked resolved or low priority, and the reply never confirms the injected instruction.
- **Probe 2, crisis:** the message is always escalated to a person (critical, safeguarding) with 999 and Samaritans shown, and never closed by an automated reply.

---

## Project layout

```
db/001-initial.sql            Schema: conversations, turns, cases (+ integrity constraints)
scripts/migrate.mjs           Applies the schema
src/app/                      Student chat (/) and staff dashboard (/staff)
src/app/api/                  chat, conversations, staff/session, staff/cases
src/data/knowledge-base.json  The approved guidance, word for word from the brief
src/lib/
  conversation-service.ts     Turn lifecycle: reserve → model → policy → save
  model.ts                    Gemini client, prompt, retries and fallback model
  triage-schema.ts            Zod schema for the model's proposal
  policy.ts                   House rules and reply grounding checks
  safety.ts                   Model-independent risk signals (shared with the browser)
  catalogue.ts                Knowledge-base lookup and resource cards
  staff-service.ts            Case queue, claiming, resolving
  auth.ts                     Student sessions, signed staff cookies, CSRF origin check
  db.ts, http.ts              Connection pool/transactions; API error and input handling
tests/                        Probes, policy tests, DB/HTTP integration, model evaluation
```

---

## Design highlights

**Safe case claiming.** Claiming is a single conditional statement:

```sql
UPDATE cases SET claimed_by = $me, status = 'in_progress'
WHERE id = $1 AND status = 'new' AND claimed_by IS NULL
```

PostgreSQL locks the row during the update, so if two staff claim at the same moment the second update re-checks the condition, matches nothing, and that person gets "already claimed by …" (HTTP 409). A read-then-write approach would let both see `new` and both believe they own the case. `npm run test:db` fires two simultaneous claims and checks for exactly one success and one 409.

**Database integrity.** A `CHECK` constraint ties case status to ownership; partial unique indexes allow at most one in-flight turn per conversation (no interleaved replies) and at most one open case per conversation (repeat escalations update it rather than flooding the queue). A unique `request_id` per turn makes retries safe.

**No transaction across the AI call.** Model calls take seconds, so the turn is reserved in one short transaction and saved in another; no row lock is held while waiting on Gemini.

**Sessions.** Students are anonymous: an HTTP-only random token cookie, stored only as a SHA-256 hash in the database. Staff cookies are HMAC-signed, so the acting staff member always comes from the server, never from the request body. State-changing requests are origin-checked.

**No retrieval layer.** The whole knowledge base is about 3.5k tokens, so every model call receives all of it. With 13 entries, search only adds ways to miss the right one. Resource links shown to students come from our data, never from model text.

---

## Questions from the brief

**If this served 50 organisations and 10,000 conversations a day, what would you change?**
Add an `organisation_id` to every table and enforce it with row-level security, so one university can never see another's students; each would also get its own knowledge base and staff accounts. 10,000 conversations a day is only a few messages a second, so the database is fine; the bottleneck is the AI provider. I'd add per-organisation rate limits, a paid tier with a fallback provider, and caching for common answers. Larger knowledge bases would need real retrieval (embeddings in pgvector) instead of sending everything. And I'd add monitoring that matters here: model failure rate and the age of unclaimed critical cases, with alerts.

**This is real students' personal and welfare data. What would you do differently for privacy and safety?**
Proper staff sign-in (university SSO with MFA) and roles, an audit log of who viewed which case, and encryption of sensitive fields. Agree a retention period and delete old conversations automatically. Use an AI provider under a data-processing agreement that doesn't train on or keep the data, in a UK/EU region, and remove names and contact details before text is sent (partly done today). Students would be told clearly what is stored and that it's not an emergency service. A crisis case would also page an on-call person, not just wait in a queue. And the safeguarding wording and rules would be reviewed by the university's welfare and safeguarding leads.

**How does the assistant decide what to answer itself and what to escalate?**
For every message, an AI reads it and suggests what kind of problem it is, how urgent it is, and a reply based only on the university's approved guidance. Before anything is shown, fixed safety rules check that suggestion: anything suggesting danger, a crisis, an immigration or legal situation, or anything the guidance doesn't cover goes to a member of staff, and the AI can't overrule that. It answers routine questions itself, and if a message is too vague it asks one short question first.

---

## Limitations

This is a demo, not a production welfare service. Staff accounts are fixed demo users, there is no data-retention job or audit log yet, and the safety wording has not been reviewed by safeguarding professionals. See [DECISIONS.md](DECISIONS.md) for what was deliberately left out and why.
