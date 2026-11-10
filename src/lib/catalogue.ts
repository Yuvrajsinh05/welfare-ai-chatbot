/**
 * The approved knowledge base: the 13 resources from the brief, stored word-for-word in JSON.
 * It is small (~3.5k tokens), so every model call receives all of it instead of a keyword search.
 */
import knowledgeBase from '../data/knowledge-base.json';

export type Entry = (typeof knowledgeBase.entries)[number];
export type Resource = { id: string; title: string; url: string };

export const catalogue: Entry[] = knowledgeBase.entries;
export const catalogueIds = catalogue.map(entry => entry.id);

/** What the model sees: id, title, link and facts. */
export const guidanceForModel = catalogue.map(({ id, title, url, phone, facts }) => ({ id, title, link: url ?? `phone ${phone}`, facts }));

/**
 * Outage fallback only: when the model is unavailable, pick at most two likely resource cards so the
 * student still has somewhere to go. Whole-word matches, to avoid "example" -> exam style mistakes.
 * This never decides routing and never feeds the model.
 */
const FALLBACK_HINTS: [string, RegExp][] = [
  ['hardship', /\b(scholarship|bursary|maintenance loan|rent|can't afford|money|hardship|food)\b/i],
  ['fees', /\b(tuition|fees?|fee.slip|instalment|payment plan)\b/i],
  ['library', /\b(past (exam )?papers|reading lists?|library|module materials)\b/i],
  ['mitigation', /\b(extension|extenuating|mitigating|missed (an )?exam|deadline)\b/i],
  ['it', /\b(password|log ?in|sign ?in|wi-?fi|email account|mfa|locked out)\b/i],
  ['deposit', /\b(deposit|landlord|tenancy)\b/i],
  ['careers', /\b(cv|part.time job|careers?|internship)\b/i],
  ['disability', /\b(disabilit\w*|dyslexi\w*|adjustments?)\b/i],
  ['wellbeing', /\b(stress(ed)?|anxious|anxiety|low mood|worried|lonely|homesick|counselling)\b/i],
];
export function suggestResources(text: string): string[] {
  return FALLBACK_HINTS.filter(([, pattern]) => pattern.test(text)).map(([id]) => id).slice(0, 2);
}

/** Turns cited ids into the resource cards shown under a reply. Unknown ids are dropped. */
export function resourceCards(ids: string[]): Resource[] {
  return catalogue
    .filter(entry => ids.includes(entry.id))
    .map(entry => ({ id: entry.id, title: entry.title, url: entry.url ?? `tel:${entry.phone?.replaceAll(' ', '')}` }));
}
