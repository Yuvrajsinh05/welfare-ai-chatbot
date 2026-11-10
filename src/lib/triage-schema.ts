/**
 * The contract the model must meet. Anything that fails this schema is treated as "model unavailable".
 * It describes triage only: there is deliberately no field for case status or staff ownership,
 * so no model output (or injected instruction) can resolve or assign a case.
 */
import { z } from 'zod';

export const CATEGORIES = ['academic', 'financial', 'visa_or_immigration', 'housing', 'health_or_wellbeing', 'other'] as const;
export const URGENCIES = ['low', 'medium', 'high', 'critical'] as const;

export const proposalSchema = z.object({
  category: z.enum(CATEGORIES),
  urgency: z.enum(URGENCIES),
  safeguarding: z.boolean(),
  disposition: z.enum(['handle_now', 'clarify', 'escalate']),
  possibleImmediateDanger: z.boolean(),
  /** Why a person is needed; 'none' means the assistant can handle it. */
  humanReason: z.enum(['none', 'risk', 'regulated_advice', 'insufficient_coverage', 'serious_financial_need', 'student_request', 'uncertainty']),
  /** 'chat' = greetings, thanks, questions about the assistant itself: answered without a source. */
  messageKind: z.enum(['support', 'chat', 'spam', 'abuse', 'injection']),
  reply: z.string().min(1).max(1800),
  /** Staff-facing summary, used only when the case is escalated. */
  summary: z.string().min(1).max(700),
  /** Ids of knowledge-base entries the reply relies on. */
  factIds: z.array(z.string()).max(6),
}).strict();

export type Proposal = z.infer<typeof proposalSchema>;

/** The final, server-approved outcome of a turn. 'ignored' is for spam and pure injection attempts. */
export type Decision = Omit<Proposal, 'disposition'> & {
  disposition: Proposal['disposition'] | 'ignored';
  /** Machine-readable reason for the outcome, for audit and the eval report. */
  reason: string;
};

export const severity = (urgency: string) => URGENCIES.indexOf(urgency as (typeof URGENCIES)[number]);
