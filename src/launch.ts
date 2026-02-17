/**
 * Cross-platform command resolution for node-pty launch.
 *
 * On Windows, node-pty (CreateProcessW) cannot spawn .cmd/.bat files directly.
 * Previously, shellWrap() wrapped ALL commands in cmd.exe /c - even native .exe
 * binaries. This module resolves the actual executable via PATHEXT and only
 * falls back to COMSPEC for .cmd/.bat scripts.
 */

import * as path from 'path'
import which = require('which')

export interface ResolvedCommand {
  command: string
  args: string[]
  found: boolean
}

/**
 * Resolve a command name for use with node-pty.
 *
 * - Unix: resolve full path via PATH (execvp handles shebangs natively).
 * - Windows .exe/.com: return full path for direct spawn (no cmd.exe wrapper).
 * - Windows .cmd/.bat: wrap in COMSPEC with /d /s /c flags.
 * - Not found: wrap in COMSPEC as fallback (lets cmd.exe produce the error).
 */
export async function resolveForPty (
  name: string,
  args: string[],
): Promise<ResolvedCommand> {
  if (process.platform !== 'win32') {
    const resolved = await which(name, { nothrow: true })
    return { command: resolved ?? name, args, found: !!resolved }
  }

  // Windows: resolve via PATHEXT to decide spawn strategy
  const resolved = await which(name, { nothrow: true })
  if (!resolved) {
    // Not found — fallback to COMSPEC (current behavior)
    const comspec = process.env.COMSPEC || 'cmd.exe'
    return { command: comspec, args: ['/d', '/s', '/c', name, ...args], found: false }
  }

  const ext = path.extname(resolved).toLowerCase()
  if (ext === '.exe' || ext === '.com') {
    // Native binary: spawn directly — no cmd.exe wrapper
    return { command: resolved, args, found: true }
  }

  // .cmd/.bat: must use COMSPEC
  const comspec = process.env.COMSPEC || 'cmd.exe'
  return {
    command: comspec,
    args: ['/d', '/s', '/c', `"${resolved}"`, ...args],
    found: true,
  }
}

/** Env vars that must be stripped to prevent nesting guards from blocking launch. */
const NESTING_VARS = ['CLAUDECODE']

/**
 * Build a clean environment for terminal launch.
 * Merges extras into baseEnv and strips nesting guard variables.
 */
export function cleanEnv (
  baseEnv: Record<string, string>,
  extras: Record<string, string>,
): Record<string, string> {
  const env = { ...baseEnv, ...extras }
  // Set to empty string (not delete) — the PTY inherits process.env,
  // so deleting the key from options still leaves the parent value visible.
  for (const key of NESTING_VARS) env[key] = ''
  return env
}
