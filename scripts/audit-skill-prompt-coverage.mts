// Round 320 audit: for each skill, find allowedTools that are NOT mentioned in
// its systemPrompt. These are "invisible tools" the agent can call but doesn't
// know it should. Output a report to guide prompt improvements.
import { DEFAULT_SKILLS } from '../engine/skills/SkillRegistry.js';

let totalGaps = 0;
const skillGaps: Array<{ skill: string; unmentioned: string[] }> = [];

for (const skill of DEFAULT_SKILLS) {
  const prompt = skill.systemPrompt.toLowerCase();
  const unmentioned: string[] = [];
  for (const tool of skill.allowedTools) {
    // A tool is "mentioned" if its name (or a close variant) appears in the prompt.
    // We check the exact tool name and also common human-readable forms.
    const variants = [
      tool,
      tool.replace(/_/g, ' '),
      tool.replace(/_/g, ''),
    ];
    const mentioned = variants.some((v) => prompt.includes(v.toLowerCase()));
    if (!mentioned) unmentioned.push(tool);
  }
  if (unmentioned.length > 0) {
    skillGaps.push({ skill: skill.id, unmentioned });
    totalGaps += unmentioned.length;
  }
}

console.log('=== Round 320: skill prompt coverage audit ===\n');
console.log(`Skills with unmentioned tools: ${skillGaps.length} / ${DEFAULT_SKILLS.length}`);
console.log(`Total unmentioned tool-references: ${totalGaps}\n`);

for (const { skill, unmentioned } of skillGaps.sort((a, b) => b.unmentioned.length - a.unmentioned.length)) {
  console.log(`[${skill}] ${unmentioned.length} unmentioned:`);
  for (const t of unmentioned) console.log(`  - ${t}`);
  console.log('');
}

// Summary: which skills are worst offenders?
console.log('--- Top offenders (most unmentioned) ---');
for (const { skill, unmentioned } of skillGaps.slice(0, 5)) {
  console.log(`  ${skill}: ${unmentioned.length}`);
}
