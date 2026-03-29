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
 * Load skills from a directory. Supports two formats:
 * 1. Flat .md files: skills/my-skill.md
 * 2. Directories with SKILL.md: skills/my-skill/SKILL.md
 * The name is derived from the filename or directory name.
 * The first line starting with # is the description.
 */
export function loadSkillsFromDir(dir: string): void {
  if (!existsSync(dir)) return

  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      let name: string
      let content: string

      if (entry.isFile() && extname(entry.name) === '.md') {
        // Flat .md file: skills/my-skill.md
        name = basename(entry.name, '.md')
        content = readFileSync(join(dir, entry.name), 'utf8')
      } else if (entry.isDirectory()) {
        // Directory with SKILL.md: skills/my-skill/SKILL.md
        const skillPath = join(dir, entry.name, 'SKILL.md')
        if (!existsSync(skillPath)) continue
        name = entry.name
        content = readFileSync(skillPath, 'utf8')
      } else {
        continue
      }

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
