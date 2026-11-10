/**
 * Local, model-independent safety signals. Shared by the browser (instant emergency banner)
 * and the server (house rules). These can only RAISE risk: no match never means "safe",
 * because the model is still asked to judge every ordinary message.
 */
export const emergencyText =
  'If you might be in immediate danger, please call 999 now. You can also call Samaritans free on 116 123, any time, day or night.';

const DANGER = [
  /\b(kill|hurt|harm|cut) myself\b/,
  /\b(end|take) (my|my own) life\b/,
  /\bsuicid\w*/,
  /\boverdos\w*/,
  /\bwant(ed)? to die\b/,
  /\bdon't want to (be here|live|wake up)\b/,
  /\b(no reason|nothing) to live\b/,
  /\bbetter off without me\b/,
  /\bend it all\b/,
  /\b(can't|cannot) keep myself safe\b/,
  /\b(immediate danger|in danger (right )?now|my life is in danger)\b/,
  /\b(threatening|attacking|following) me\b/,
];
// Physical emergencies: injury, accident, someone not breathing. Handled with an ambulance-first reply.
const MEDICAL = /\b(bleeding|lots of blood|blood is|so much blood|unconscious|not breathing|can't breathe|cannot breathe|chest pain|seizure|overdosed|collapsed|badly (hurt|injured)|car (crash|accident)|road accident|(been|was) in an accident|hit by a (car|bus|van|bike)|crashed (my|the|a) (car|vehicle|vehical|bike|scooter|motorbike))\b/;
// Withdrawal + hopelessness together is a recognised warning pattern even without explicit words.
const WITHDRAWAL = /\b(haven't|not|barely) (left my room|been eating|eaten|eating|slept)\b/;
const HOPELESS = /\b(no point|see the point|hopeless|can't go on|give up on everything)\b/;
// Needs a person (safeguarding), but not necessarily an emergency.
const RISK = /\b(self.harm\w*|unsafe|harass\w*|bully\w*|stalk\w*|sexual (misconduct|assault)|assault\w*|abus\w*|can't cope|crisis|panic attacks?)\b|mental health.{0,40}(downhill|worse|wors\w+|deteriorat\w*)/;
// Negations we deliberately discount, so "I'm not suicidal" alone does not trigger an emergency.
const NEGATED = /\b(i am|i'm) not (suicidal|in danger)\b/g;

export function riskSignals(text: string) {
  const lower = text.toLowerCase().replaceAll('’', "'").replace(NEGATED, '');
  const medical = MEDICAL.test(lower);
  const danger = medical || DANGER.some(pattern => pattern.test(lower)) || (WITHDRAWAL.test(lower) && HOPELESS.test(lower));
  return { danger, medical, risk: danger || RISK.test(lower) };
}

/** Obvious promotional spam, used only when the model is unavailable to decide. */
export function looksLikeSpam(text: string) {
  return /\b(bit\.ly|tinyurl|followers|crypto|casino|click here|buy now|promo code)\b/i.test(text);
}
