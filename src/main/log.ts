/**
 * Minimal leveled logger for the main process. Driver, MCP, and store
 * failures mostly travel to the renderer as DbResults or events; this adds
 * the main-side trace to look at when debugging a field report. Console
 * transport only — deliberately tiny. Never log SQL text, record contents,
 * or secrets at call sites.
 */

type Level = 'info' | 'warn' | 'error'

function write(level: Level, scope: string, message: string, detail?: unknown): void {
  const line = `${new Date().toISOString()} [${scope}] ${message}`
  if (detail === undefined) console[level](line)
  else console[level](line, detail)
}

export const log = {
  info: (scope: string, message: string, detail?: unknown): void =>
    write('info', scope, message, detail),
  warn: (scope: string, message: string, detail?: unknown): void =>
    write('warn', scope, message, detail),
  error: (scope: string, message: string, detail?: unknown): void =>
    write('error', scope, message, detail)
}
