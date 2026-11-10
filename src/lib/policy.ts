/**
 * House rules, enforced in code. The model only *proposes*; this module decides.
 *
 * applyPolicy() checks rules in strict priority order and the first match wins:
 *   1. Possible immediate danger  -> escalate, critical, safeguarding, emergency numbers
 *   2. Crisis / risk              -> escalate, safeguarding, at least high
 *   3. Immigration                -> escalate with fixed, restrained wording (regulated in the UK)
 *   4. Individual legal dispute   -> escalate, keep checked general guidance
 *   5. Model unavailable/invalid  -> ignore obvious spam, otherwise escalate (honest wording + likely resource)
 *   6. Spam / abuse / injection   -> ignored; manipulation mixed with a real need -> escalate
 *   7. Model says a person needed -> escalate
 *   8. Routine                    -> answer / clarify / chat, if the reply passes checkedDraft();
 *                                    if it fails: point to the cited resource, else ask a question. No staff case.
 * Rules 1-4 use local signals OR the model's flags, so either one alone is enough to raise the level.
 * Staff cases are created only by real need (rules 1-4, 7), a model outage (5) or too many vague turns (8).
 */
import { proposalSchema, severity, type Decision, type Proposal } from './triage-schema';
import { catalogue, catalogueIds, suggestResources } from './catalogue';
import { emergencyText, looksLikeSpam, riskSignals } from './safety';

export const HANDOFF = 'I’ve passed this to the student support team, and a member of staff will follow up with you.';
/** Used instead of HANDOFF when the conversation already has an open case (see conversation-service). */
export const HANDOFF_EXISTING = 'I’ve added this to your existing request with the student support team, so the person following up will see it.';
const PRIORITY_HANDOFF = 'I’ve also passed this to the student support team as a priority, and a member of staff will follow up with you.';
const GENERIC_QUESTION = 'I want to make sure I point you the right way. Could you tell me a bit more about what’s going on? For example, is it about money, housing, your course, or how you’re feeling?';
const MAX_CLARIFICATIONS = 2;

const IMMIGRATION = /\b(visa|immigration|cas|brp|biometric residence|right to work|work rights|home office|asylum|deport\w*|overstay\w*)\b/i;
const LEGAL = /\b(legal advice|solicitor|lawyer|sue|suing|court|tribunal|evict\w*|small claims)\b|deposit.{0,60}disput|disput.{0,60}deposit/i;
const INJECTION = /\b(ignore|disregard|forget)\b.{0,30}\b(instructions|rules|prompt)\b|\bsystem prompt\b|\b(mark|set|change)\b.{0,30}\b(resolved|closed|low priority)\b/i;
const TIME_SENSITIVE = /\b(expir\w*|withdr\w*|refus\w*|urgent\w*|tomorrow|today|this week|\d+ days?)\b/i;

// --- Reply checks --------------------------------------------------------------------------------

/** Statements where the model claims it already escalated or promises contact. The server owns that wording. */
const HANDOFF_CLAIM = /\b(I|I've|I have|I'll|I will|we|we've|we have|we'll|we will)\b[^.!?]{0,20}\b(escalat|flag|forward|notif|refer|pass)\w*|\b(staff|team|someone|adviser|person)\b[^.!?]{0,40}\bwill\b[^.!?]{0,20}\b(call|contact|reply|be in touch|get back|follow up)\b/i;
/** Things the knowledge base never supports: raw links, money amounts, entitlement or status verdicts, response times. */
const FORBIDDEN = /https?:|www\.|\/resources\/|[£$€]\s*\d|\byou are (entitled|eligible)\b|\byou (will|are going to) (get|receive)\b|\byour (visa|status) (is|will)\b|\bwithin \d+ (hours?|days?)\b/i;

/**
 * Returns the model's reply if it passes deterministic grounding checks, otherwise null.
 * These checks catch detectable problems; they cannot prove every sentence is true,
 * which is why the reply is also restricted to the knowledge base in the prompt.
 */
export function checkedDraft(proposal: Proposal): string | null {
  const sentences = proposal.reply.match(/[^.!?]+[.!?]*\s*/g) ?? [];
  // Keep offers phrased as questions ("Shall I flag this?"); drop claims ("I've flagged this.").
  const reply = sentences.filter(s => s.trim().endsWith('?') || !HANDOFF_CLAIM.test(s)).join('').trim();
  if (!reply) return null;
  if (proposal.factIds.some(id => !catalogueIds.includes(id))) return null;
  if (FORBIDDEN.test(reply)) return null;
  if (/\bguarantee/i.test(reply.replace(/\b(not|no|never|isn't|can't|cannot)\s+(be\s+)?guarantee\w*/gi, ''))) return null;

  if (proposal.disposition === 'clarify') {
    // A clarification must actually ask something, and stay short.
    const questions = (reply.match(/\?/g) ?? []).length;
    return questions >= 1 && questions <= 3 && reply.length <= 500 ? reply : null;
  }
  // Greetings and "what can you do?" need no source, but stay short so they can't carry substantive advice.
  if (proposal.messageKind === 'chat') return reply.length <= 600 ? reply : null;
  // An escalation reply with no source is fine if it's a short acknowledgement: a person follows up anyway.
  if (proposal.disposition === 'escalate' && !proposal.factIds.length) return reply.length <= 400 ? reply : null;
  // A substantive answer must cite at least one approved resource.
  return proposal.factIds.length ? reply : null;
}

// --- Decision builders ---------------------------------------------------------------------------

type Base = Pick<Decision, 'category' | 'urgency' | 'safeguarding' | 'messageKind'>;
const NO_MODEL: Base = { category: 'other', urgency: 'high', safeguarding: false, messageKind: 'support' };

const maxUrgency = (...levels: Decision['urgency'][]) =>
  levels.reduce((a, b) => (severity(b) > severity(a) ? b : a));

/** Staff summary: the model's own summary only if it agreed a person is needed; otherwise the student's words. */
function staffSummary(text: string, proposal: Proposal | null) {
  if (proposal && proposal.disposition === 'escalate') return proposal.summary;
  return `Student wrote: “${text.slice(0, 450)}${text.length > 450 ? '…' : ''}”`;
}

function escalate(
  base: Base, text: string, proposal: Proposal | null, reason: string,
  opts: { humanReason: Decision['humanReason']; guidance?: string | null; factIds?: string[]; danger?: boolean },
): Decision {
  // We're escalating anyway, so drop any "Would you like me to flag this?" offer from the model's draft.
  const withoutOffer = opts.guidance?.replace(/[^.!?]*\b(flag|pass|let the team know|escalat)\w*[^.!?]*\?\s*/gi, '').trim();
  const opening = withoutOffer || 'Thank you for telling me. This is something a member of our team should help you with directly.';
  return {
    ...base,
    disposition: 'escalate',
    possibleImmediateDanger: opts.danger ?? false,
    humanReason: opts.humanReason,
    reply: `${opening}\n\n${HANDOFF}`,
    summary: staffSummary(text, proposal),
    factIds: opts.guidance ? (opts.factIds ?? proposal?.factIds ?? []) : (opts.factIds ?? []),
    reason,
  };
}

function ignored(text: string, proposal: Proposal | null, kind: Decision['messageKind'], reason: string): Decision {
  // Never record 'low': an injection that asks for "low priority" must not get it.
  return {
    category: 'other', urgency: 'medium', safeguarding: false, disposition: 'ignored', possibleImmediateDanger: false,
    humanReason: 'none', messageKind: kind, factIds: [], reason,
    reply: 'I can only help with student support questions here. If something’s going on, tell me in your own words and I’ll help.',
    summary: proposal?.summary ?? text.slice(0, 200),
  };
}

// --- The policy ----------------------------------------------------------------------------------

export function applyPolicy(text: string, raw: unknown, clarificationCount = 0): Decision {
  const signals = riskSignals(text);
  const parsed = proposalSchema.safeParse(raw);
  const p = parsed.success ? parsed.data : null;
  const draft = p ? checkedDraft(p) : null;
  const base: Base = p ? { category: p.category, urgency: p.urgency, safeguarding: p.safeguarding, messageKind: p.messageKind } : NO_MODEL;

  // 1. Possible immediate danger: emergency numbers now, human immediately. Never ask questions first.
  if (signals.danger || p?.possibleImmediateDanger || p?.urgency === 'critical') {
    const decision = escalate({ ...base, category: p?.possibleImmediateDanger ? p.category : 'health_or_wellbeing', urgency: 'critical', safeguarding: true },
      text, p, 'possible_immediate_danger', { humanReason: 'risk', factIds: signals.medical ? ['emergency'] : ['emergency', 'samaritans'], danger: true });
    // A physical emergency needs an ambulance first; a mental-health crisis needs warmth and both numbers.
    decision.reply = signals.medical
      ? `Please call 999 now and ask for an ambulance, or ask someone near you to call. Don’t wait for a reply here.\n\n${PRIORITY_HANDOFF}`
      : `I’m really glad you told me, and I’m sorry you’re going through this. ${emergencyText}\n\n${PRIORITY_HANDOFF} You don’t have to deal with this on your own.`;
    return decision;
  }

  // 2. Crisis or risk: always reaches a person; a kind automated answer never closes it.
  if (signals.risk || p?.safeguarding || p?.humanReason === 'risk') {
    // Without a usable model draft, still point to the right non-urgent service while a person picks it up.
    const harassment = /harass|bully|stalk|assault|misconduct|abus/i.test(text);
    const fallbackGuidance = harassment
      ? 'Thank you for telling me. I’m sorry this has happened, and it isn’t something you should have to deal with alone. The Report and Support service below lets you report it, anonymously if you prefer, and talk to a trained adviser.'
      : 'Thank you for telling me. That sounds like a lot to be carrying. The Wellbeing and Counselling service below is there if you’d like to talk to someone.';
    return escalate({ ...base, urgency: maxUrgency(base.urgency, 'high'), safeguarding: true }, text, p, 'safeguarding', {
      humanReason: 'risk',
      guidance: draft ?? fallbackGuidance,
      factIds: draft ? p!.factIds : [harassment ? 'report' : 'wellbeing'],
    });
  }

  // 3. Immigration: regulated advice. Fixed wording, so no model interpretation of visa rules reaches the student.
  if (IMMIGRATION.test(text) || p?.category === 'visa_or_immigration') {
    return escalate({ ...base, category: 'visa_or_immigration', urgency: maxUrgency(base.urgency, TIME_SENSITIVE.test(text) ? 'high' : 'medium') },
      text, p, 'regulated_advice', {
        humanReason: 'regulated_advice', factIds: ['visa'],
        guidance: 'That sounds really worrying, and I want to make sure you get the right help. Visa and immigration questions depend on your individual circumstances, so they need a qualified adviser rather than me. The official GOV.UK Student visa guidance is linked below for the general rules.',
      });
  }

  // 4. Individual legal disputes: share general guidance, but a person handles the specific case.
  if (LEGAL.test(text) || p?.humanReason === 'regulated_advice') {
    return escalate({ ...base, urgency: maxUrgency(base.urgency, 'medium') }, text, p, 'regulated_advice', {
      humanReason: 'regulated_advice',
      guidance: draft ?? 'I can share general information, but your specific situation needs someone qualified to look at it with you.',
      factIds: draft ? p!.factIds : /deposit|landlord|tenan/i.test(text) ? ['deposit'] : [],
    });
  }

  // 5. Model unavailable (after the fallback model too): don't guess, escalate as the brief asks,
  //    but stay honest and still show the most likely resource. Urgency reflects the words, not the outage,
  //    so a provider incident doesn't bury genuinely urgent cases under "high" routine ones.
  if (!p) {
    if (looksLikeSpam(text)) return ignored(text, null, 'spam', 'spam_without_model');
    const ids = suggestResources(text);
    const guidance = 'Sorry, I’m having trouble giving you a proper answer right now, and I’d rather not guess.'
      + (ids.length ? ' In the meantime, the resource below covers this kind of question.' : '');
    return escalate({ ...NO_MODEL, urgency: TIME_SENSITIVE.test(text) || /\b(asap|due|now)\b/i.test(text) ? 'high' : 'medium' },
      text, null, 'model_unavailable', { humanReason: 'uncertainty', guidance, factIds: ids });
  }

  // 6. Nuisance. Manipulation alongside a genuine need goes to a person instead of being dropped.
  const injection = INJECTION.test(text);
  if (p.messageKind === 'spam' || p.messageKind === 'abuse' || p.messageKind === 'injection') {
    return ignored(text, p, p.messageKind, p.messageKind === 'injection' || injection ? 'instruction_attempt' : 'nuisance');
  }
  // The model's draft is not reused here: it was written while being manipulated, so it may echo the instruction.
  if (injection) return escalate({ ...base, urgency: maxUrgency(base.urgency, 'medium') }, text, p, 'manipulation_with_need', { humanReason: 'uncertainty' });

  // 7. The model's own triage. If either field says a person is needed, a person gets it.
  const needsHuman = p.humanReason !== 'none';
  if (p.disposition === 'escalate' || needsHuman) {
    const reason = needsHuman ? p.humanReason : 'uncertainty';
    return escalate(base, text, p, reason, { humanReason: reason, guidance: draft });
  }

  // 8. Routine replies. A failed check does NOT create a staff case: fall back to something safe and still useful.
  const atLimit = p.disposition === 'clarify' && clarificationCount >= MAX_CLARIFICATIONS;
  if (atLimit) return escalate(base, text, p, 'clarification_limit', { humanReason: 'uncertainty' });
  if (draft) {
    if (p.disposition === 'clarify') return { ...p, reply: draft, factIds: [], reason: 'needs_context' };
    return { ...p, disposition: 'handle_now', reply: draft, reason: p.messageKind === 'chat' ? 'conversation' : 'answered' };
  }
  const known = catalogue.filter(entry => p.factIds.includes(entry.id) && entry.url?.startsWith('/'));
  if (known.length) {
    // The model's wording failed a check, but its choice of resource is valid: point there, in our own words.
    return {
      ...p, disposition: 'handle_now', factIds: known.map(entry => entry.id), reason: 'pointer_fallback',
      reply: `The best place for this is the ${known.map(entry => entry.title.split(',')[0]).join(' and the ')} guidance, linked below. If you tell me a bit more about your situation, I can talk you through the next steps.`,
    };
  }
  if (clarificationCount >= MAX_CLARIFICATIONS) return escalate(base, text, p, 'clarification_limit', { humanReason: 'uncertainty' });
  return { ...p, disposition: 'clarify', factIds: [], reason: 'clarify_fallback', reply: GENERIC_QUESTION };
}
