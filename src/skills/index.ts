import { readFileSync, readdirSync, existsSync } from 'fs'
import { join, extname, basename } from 'path'
import type { Skill } from '../types'

const skills = new Map<string, Skill>()

export function registerSkill(skill: Skill): void {
  skills.set(skill.name, skill)
}

export function getSkill(name: string): Skill | undefined {
  return skills.get(name)
}

export function listSkills(): Skill[] {
  return Array.from(skills.values())
}

/**
 * Load skills from a directory. Each .md file becomes a skill.
 * The filename (without extension) is the skill name.
 * The first line starting with # is the description.
 */
export function loadSkillsFromDir(dir: string): void {
  if (!existsSync(dir)) return

  try {
    const files = readdirSync(dir)
    for (const file of files) {
      if (extname(file) !== '.md') continue
      const name = basename(file, '.md')
      const content = readFileSync(join(dir, file), 'utf8')

      // Extract description from first heading
      const headingMatch = content.match(/^#\s+(.+)$/m)
      const description = headingMatch ? headingMatch[1] : name

      registerSkill({ name, description, content })
    }
  } catch (err) {
    console.error(`skills: failed to load from ${dir}: ${err}`)
  }
}

/** Initialize skill system — load from project skills/ directory. */
export function initSkills(projectDir: string): void {
  loadSkillsFromDir(join(projectDir, 'skills'))
  console.error(`skills: loaded ${skills.size} skill(s)`)
}
