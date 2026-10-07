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

// ---- the event-tree lessons: a separate sheet, so that a sign-off of the fault-tree lessons above is not disturbed by them ----
const etDir = path.join(dir, 'event-trees');
const key = (k) => k.split(',').map((x) => x.replace(':', ' ')).join(', ');
const et = [
  '# Event-tree lesson review sheet and instructor guide',
  '',
  'Generated from `lessons/event-trees/*.json` by `node scripts/lesson-review.mjs`. Regenerate after any change to a lesson, because a sign-off applies to the text below and nothing else. The fault-tree lessons have their own sheet, [LESSON-REVIEW.md](LESSON-REVIEW.md).',
  '',
  'The reviewer is the course instructor or another subject-matter reader, not the author of the lessons. A mechanical readability score and the author\'s own read are not a review. **The instructor\'s questions and model answers below are never sent to the student\'s browser.**',
  '',
  '## What to check in each lesson',
  '',
  '1. Is every statement true, including the hand calculations and the numbers in the expected results?',
  '2. Does anything state or imply a real plant, a safety conclusion or a licensing judgement? (Every end state a student names is theirs, and the tool marks examples as examples.)',
  '3. Is the wording right for the students (reading level, jargon introduced after plain language)?',
  '4. Does each step say what a student must do, in the words the editor uses?',
  '5. Does each "check this" message teach the right thing without giving the answer away?',
  '6. The shared-event lesson asks for a prediction BEFORE the analysis and then shows the product of the two failure probabilities beside the exact value. Is that the comparison you want to teach, and is "about a third too low" (the product is 32.7 percent below the exact value) fair wording?',
  '7. Are the instructor\'s questions and model answers right, and enough for a short discussion?',
  '',
];
for (const f of readdirSync(etDir).filter((x) => x.endsWith('.json')).sort()) {
  const l = JSON.parse(readFileSync(path.join(etDir, f), 'utf8'));
  const m = l.model.document;
  et.push(`## ${l.title}`, '', `File: \`lessons/event-trees/${f}\``, '', '**Goals**', ...l.goals.map((g) => `- ${g}`), '', `**Assumptions shown to the student:** ${l.assumptions}`, '');
  et.push(`**The fault-tree model the lesson saves for the student** (as \`${l.model.name}\`): top event \`${m.top}\`.`);
  et.push(...m.events.map((e) => `- basic event \`${e.id}\`${e.name ? ` (${e.name})` : ''}: probability ${e.probability}`));
  et.push(...m.gates.map((g) => `- gate \`${g.id}\`${g.name ? ` (${g.name})` : ''}: ${g.type.toUpperCase()} of ${g.inputs.map((i) => `\`${i}\``).join(', ')}`), '');
  et.push('**Steps**');
  l.steps.forEach((s2, i) => et.push(`${i + 1}. ${s2.prompt}`, `   - Hint: ${s2.hint}`));
  if (l.prediction) et.push('', `**Prediction asked before the analysis:** ${l.prediction.prompt}`);
  et.push('', '**Expected results** (each equals an independently checked oracle entry, re-derived by exact enumeration in the tests)');
  for (const o of l.outcomes) {
    et.push(`- ${o.label} (oracle \`${o.oracle}\`), frequency of each sequence per year:`);
    et.push(...o.frequencies.map((x) => `  - ${key(x.key)}: ${x.frequency}`));
  }
  et.push('', '**"Check this" messages**', ...l.mistakes.map((x) => `- ${x.message}`), '', '**Hand calculation (shown after the student has analysed the tree)**', ...l.hand_calculation.map((t) => `- ${t}`), '');
  et.push('**For the instructor: discussion questions and model answers (not shown to students)**');
  for (const d of l.discussion) et.push(`- Question: ${d.question}`, `  - Model answer: ${d.answer}`);
  et.push('', '**Reviewer**', '', '- Name and role: ', '- Date: ', '- Verdict (approved / approved with changes / not approved): ', '- Changes asked for: ', '');
}

const outputs = [
  [path.join(root, 'docs', 'LESSON-REVIEW.md'), out.join('\n') + '\n'],
  [path.join(root, 'docs', 'EVENT-TREE-LESSON-REVIEW.md'), et.join('\n') + '\n'],
];
if (process.argv.includes('--check')) {
  // exit 1 when a sheet is not what the lesson files would produce now (a sign-off applies to the text of the sheet)
  const stale = outputs.filter(([file, text]) => { try { return readFileSync(file, 'utf8') !== text; } catch { return true; } }).map(([file]) => path.relative(root, file));
  if (stale.length) { console.error(`out of date: ${stale.join(', ')}`); process.exit(1); }
  console.log('sheets are current');
} else {
  for (const [file, text] of outputs) { writeFileSync(file, text); console.log(`wrote ${path.relative(root, file)}`); }
}
