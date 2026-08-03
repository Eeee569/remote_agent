/**
 * Monaco bootstrap: workers, the "ra-dark" theme, and JSON schema registration
 * for Claude Code config files. Module-level side effects run exactly once on
 * first import; sibling modules lazy-import this and call getMonaco().
 */
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import { claudeSettingsJsonSchema, mcpJsonSchema } from '@shared/claude-schemas'

self.MonacoEnvironment = {
  getWorker: (_id: string, label: string) => (label === 'json' ? new jsonWorker() : new editorWorker())
}

monaco.editor.defineTheme('ra-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#161d27',
    'editor.foreground': '#dbe4f0',
    'editorLineNumber.foreground': '#5b6878',
    'editor.lineHighlightBackground': '#1c2532',
    'editorWidget.background': '#131a23',
    'input.background': '#0d1117',
    'focusBorder': '#3d8bfd'
  }
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
