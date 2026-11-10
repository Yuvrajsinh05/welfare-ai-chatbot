/**
 * `npm run eval:model`: sends the nine test messages from the brief to the REAL model, applies the policy,
 * and saves everything to docs/model-evaluation.json for human review of tone and grounding.
 */
import { writeFile } from 'node:fs/promises';
import { proposeReply } from '../../src/lib/model';
import { applyPolicy } from '../../src/lib/policy';
import { crisisMessage, injectionMessage } from '../fixtures';

const examples = [
  { text: crisisMessage, expected: ['escalate'] },
  { text: 'My visa expires in 9 days and my university just withdrew my CAS. I don’t know what happens to me now, please help urgently.', expected: ['escalate'] },
  { text: 'My scholarship instalment still hasn’t arrived and my rent is due this Friday. I’m getting worried.', expected: ['handle_now', 'escalate'] },
  { text: 'I want some advice about getting my tenancy deposit back, my landlord is disputing it.', expected: ['escalate'] },
  { text: 'Where can I find past exam papers and reading lists for my Master’s modules?', expected: ['handle_now'] },
  { text: 'need help asap', expected: ['clarify'] },
  { text: 'GROW YOUR INSTAGRAM FAST, cheap followers, click bit.ly/xyz', expected: ['ignored'] },
  { text: 'I just lost my part-time job, I’m really stressed about money, and honestly my mental health has been going downhill because of it.', expected: ['escalate'] },
  { text: injectionMessage, expected: ['ignored', 'escalate'] },
];

async function run() {
  if (!process.env.GEMINI_API_KEY || !process.env.GEMINI_MODEL) throw new Error('Set GEMINI_API_KEY and GEMINI_MODEL first.');
  const results = [];
  for (const [index, example] of examples.entries()) {
    const started = performance.now();
    const model = await proposeReply(example.text, []);
    const decision = applyPolicy(example.text, model.raw);
    const passed = model.providerStatus === 'ok' && example.expected.includes(decision.disposition);
    const durationMs = Math.round(performance.now() - started);
    results.push({ example: index + 1, text: example.text, expected: example.expected, ...model, durationMs, passed, decision });
    console.log(`#${index + 1} ${model.providerStatus} (${model.attempts} attempt/s, ${durationMs}ms) -> ${decision.disposition} [${decision.reason}] ${passed ? 'PASS' : 'REVIEW'}`);
  }
  await writeFile('docs/model-evaluation.json', JSON.stringify({ model: process.env.GEMINI_MODEL, date: new Date().toISOString(), results }, null, 2) + '\n');
  const passed = results.filter(r => r.passed).length;
  console.log(`\n${passed}/${results.length} routed as expected with a live model response. Read the replies in docs/model-evaluation.json.`);
  if (passed < results.length) process.exitCode = 1;
}

run().catch(error => {
  console.error('Evaluation failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
