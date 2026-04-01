const toolEmojis: Record<string, string> = {
  Bash: '🖥️',
  Read: '📖',
  Edit: '✏️',
  Write: '📝',
  Grep: '🔍',
  Glob: '📂',
  Agent: '🤖',
  Skill: '⚡',
  WebSearch: '🌐',
  WebFetch: '🌐',
  TodoWrite: '📋',
  ToolSearch: '🔧',
  NotebookEdit: '📓',
  SendMessage: '💬',
  LSP: '🧠',
}

export function formatToolUse(name: string, input: Record<string, any> = {}): string {
  const emoji = toolEmojis[name] ?? '🔧'

  let description = ''
  let details = ''

  switch (name) {
    case 'shell': {
      description = input.description || 'Running command'
      const cmd = input.command ?? ''
      details = `$ ${cmd.length > 300 ? cmd.slice(0, 297) + '...' : cmd}`
      break
    }
    case 'shell-result': {
      description = input.description || 'Command output'
      const output = input.output ?? ''
      details = output.length > 500 ? output.slice(0, 497) + '...' : output
      break
    }
    case 'Bash': {
      description = input.description || 'Running command'
      const cmd = input.command ?? ''
      details = `$ ${cmd.length > 300 ? cmd.slice(0, 297) + '...' : cmd}`
      break
    }
    case 'Read': {
      description = 'Reading file'
      details = input.file_path ?? ''
      if (input.offset || input.limit) {
        details += ` (lines ${input.offset ?? 1}-${(input.offset ?? 1) + (input.limit ?? 0)})`
      }
      break
    }
    case 'Edit': {
      description = 'Editing file'
      details = input.file_path ?? ''
      break
    }
    case 'Write': {
      description = 'Writing file'
      details = input.file_path ?? ''
      break
    }
    case 'Grep': {
      description = `Searching for "${input.pattern ?? ''}"`
      const location = input.path || input.glob || '.'
      details = `in ${location}`
      break
    }
    case 'Glob': {
      description = `Finding files: ${input.pattern ?? '*'}`
      details = input.path ? `in ${input.path}` : ''
      break
    }
    case 'Agent': {
      description = input.description || 'Running agent'
      details = input.subagent_type ? `Type: ${input.subagent_type}` : ''
      break
    }
    case 'Skill': {
      description = `Running skill: ${input.skill ?? 'unknown'}`
      details = input.args || ''
      break
    }
    case 'WebSearch': {
      description = 'Web search'
      details = input.query ?? ''
      break
    }
    case 'WebFetch': {
      description = 'Fetching URL'
      details = input.url ?? ''
      break
    }
    default: {
      description = name
      const json = JSON.stringify(input).slice(0, 200)
      details = json !== '{}' ? json : ''
      break
    }
  }

  let result = `${emoji} ${description}`
  if (details) {
    result += `\n${details}`
  }
  return result
}

export function formatToolUseRaw(name: string, input: Record<string, any> = {}): string {
  const emoji = toolEmojis[name] ?? '🔧'
  const json = JSON.stringify(input)
  const truncated = json.length > 500 ? json.slice(0, 497) + '...' : json
  return `${emoji} ${name}(${truncated})`
}
