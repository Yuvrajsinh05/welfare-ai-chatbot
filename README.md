# AI Welfare Assistant

A conversational student-support assistant. It answers routine questions from the university's own guidance, asks a short follow-up when a message is too vague, and hands anything sensitive (crisis, immigration, legal) to staff, who work the cases from a priority dashboard.

Next.js 16 · PostgreSQL (Neon) · Gemini · deployed on Vercel.

- **Live app:** _add Vercel URL_ (student chat at `/`, staff dashboard at `/staff`)
- **Demo staff logins:** _alex / bea, passwords supplied with the submission_

How it works, module by module: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Choices and trade-offs: [DECISIONS.md](DECISIONS.md).

## Run locally

Requires Node.js 22+ and a PostgreSQL database (a free Neon project works).

```bash
npm ci
cp .env.example .env.local     # then fill in DATABASE_URL, GEMINI_API_KEY, GEMINI_MODEL, SESSION_SECRET, staff passwords
npm run db:migrate
npm run dev                    # http://localhost:3000 and http://localhost:3000/staff
```

## Probes and tests

```bash
npm run probe        # the two required safety probes; exits non-zero if either fails
```

The probes run against **recorded model responses**, not the live model, so they are deterministic and need no API key. The recorded responses are deliberately wrong (the model "obeys" the injection and calls the crisis routine, plus a "model unavailable" case), so a pass shows that the server's own validation and house-rule logic enforces safety, whatever the model says.

- Probe 1 (injection): message 9 is never marked resolved or low priority, and the reply never confirms the instruction.
- Probe 2 (crisis): message 1 is always escalated to a person (critical, safeguarding) with 999 and Samaritans shown, never closed by an automated reply.

Other checks: `npm test` (house-rule tests), `npm run test:db` (real PostgreSQL, including concurrent claims), `npm run test:http` (builds the app and tests through HTTP), `npm run eval:model` (the nine brief messages against live Gemini, saved to `docs/model-evaluation.json`).

## How case claiming is made safe

Claiming is one conditional SQL statement: `UPDATE cases SET claimed_by = me, status = 'in_progress' WHERE id = $1 AND status = 'new' AND claimed_by IS NULL`. PostgreSQL locks the row during the update, so if two staff click "claim" at the same moment, the second update waits, re-checks the condition, matches nothing, and that person is told "already claimed by …" (HTTP 409). Without the condition (read the status, then write), both requests could see "new" and both staff would believe they own the same student. `npm run test:db` fires two simultaneous claims and checks for exactly one success and one 409.

## Questions from the brief

**If this served 50 organisations and 10,000 conversations a day, what would you change?**
Add an `organisation_id` to every table and enforce it with row-level security, so one university can never see another's students; each would also get its own knowledge base and staff accounts. 10,000 conversations a day is only a few messages a second, so the database is fine; the bottleneck is the AI provider. I'd add per-organisation rate limits, a paid tier with a fallback provider, and caching for common answers. Larger knowledge bases would need real retrieval (embeddings in pgvector) instead of sending everything. And I'd add monitoring that matters here: model failure rate and the age of unclaimed critical cases, with alerts.

**This is real students' personal and welfare data. What would you do differently for privacy and safety?**
Proper staff sign-in (university SSO with MFA) and roles, an audit log of who viewed which case, and encryption of sensitive fields. Agree a retention period and delete old conversations automatically. Use an AI provider under a data-processing agreement that doesn't train on or keep the data, in a UK/EU region, and remove names and contact details before text is sent (partly done today). Students would be told clearly what is stored and that it's not an emergency service. A crisis case would also page an on-call person, not just wait in a queue. And the safeguarding wording and rules would be reviewed by the university's welfare and safeguarding leads.

**How does the assistant decide what to answer itself and what to escalate?**
For every message, an AI reads it and suggests what kind of problem it is, how urgent it is and a reply based only on the university's approved guidance. Before anything is shown, fixed safety rules check that suggestion: anything suggesting danger, a crisis, an immigration or legal situation, or anything the guidance doesn't cover goes to a member of staff, and the AI can't overrule that. It answers routine questions itself, and if a message is too vague it asks one short question first.
# welfare-ai-chatbot
