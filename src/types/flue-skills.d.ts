// Let TypeScript resolve Flue skill imports (`import x from '...SKILL.md' with { type: 'skill' }`).
import type { Skill } from '@flue/runtime';
declare module '*.md' {
  const skill: Skill;
  export default skill;
}
