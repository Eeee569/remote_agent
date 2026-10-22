/**
 * Monaco bootstrap: workers, the "ra-dark" theme, and JSON schema registration
 * for Claude Code config files. Module-level side effects run exactly once on
 * first import; sibling modules lazy-import this and call getMonaco().
 */
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import { claudeSettingsJsonSchema, mcpJsonSchema } from '@shared/claude-schemas'
import { monacoColors } from '@/theme/tokens'

self.MonacoEnvironment = {
  getWorker: (_id: string, label: string) => (label === 'json' ? new jsonWorker() : new editorWorker())
}

monaco.editor.defineTheme('ra-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: monacoColors()
})

monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
  validate: true,
  enableSchemaRequest: false,
  schemas: [
    {
      uri: 'ra://schemas/claude-settings',
      fileMatch: ['*settings.json', '*settings.local.json'],
      schema: claudeSettingsJsonSchema
    },
    {
      uri: 'ra://schemas/mcp',
      fileMatch: ['*.mcp.json', '*mcp.json'],
      schema: mcpJsonSchema
    }
  ]
})

export const getMonaco = (): typeof monaco => monaco
