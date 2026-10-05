// Writes docs/LESSON-REVIEW.md: every lesson's text in reading order, for an instructor to read and sign off.
//   node scripts/lesson-review.mjs
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'lessons');
const out = [
  '# Lesson review sheet',
  '',
  'Generated from `lessons/*.json` by `node scripts/lesson-review.mjs`. Regenerate after any change to a lesson, because a sign-off applies to the text below and nothing else.',
  '',
  'The reviewer is the course instructor or another subject-matter reader, not the author of the lessons. A mechanical readability score and the author\'s own read are not a review.',
  '',
  '## What to check in each lesson',
  '',
  '1. Is every statement true, including the hand calculations?',
  '2. Does anything state or imply a real plant, a frequency or a safety conclusion?',
  '3. Is the wording right for the students (reading level, jargon introduced after plain language)?',
  '4. Does each step say what a student must do, in the words the editor uses?',
  '5. Does each "check this" message teach the right thing without giving the answer away?',
  '6. Is anything missing that a first-time student would need?',
  '',
];
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
  const l = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
  out.push(`## ${l.title}`, '', `File: \`lessons/${f}\``, '', '**Goals**', ...l.goals.map((g) => `- ${g}`), '', `**Assumptions shown to the student:** ${l.assumptions}`, '', '**Steps**');
  l.steps.forEach((s, i) => out.push(`${i + 1}. ${s.prompt}`, `   - Hint: ${s.hint}`));
  out.push('', '**Expected results** (each equals an independently checked oracle entry)');
  for (const o of l.outcomes) out.push(`- ${o.label}: probability ${o.probability}; cut sets ${o.cut_sets.map((c) => '{' + c.join(', ') + '}').join(', ')} (oracle \`${o.oracle}\`)`);
  out.push('', '**"Check this" messages**', ...l.mistakes.map((m) => `- ${m.message}`), '', '**Hand calculation (shown after the student has run the model)**', ...l.hand_calculation.map((t) => `- ${t}`), '');
  out.push('**Reviewer**', '', '- Name and role: ', '- Date: ', '- Verdict (approved / approved with changes / not approved): ', '- Changes asked for: ', '');
}
writeFileSync(path.join(root, 'docs', 'LESSON-REVIEW.md'), out.join('\n') + '\n');
console.log('wrote docs/LESSON-REVIEW.md');
