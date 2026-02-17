#!/usr/bin/env node
/**
 * Single install script for claude-code-zit:
 * 1. Deploy Claude Code plugin (hooks) to ~/.claude/plugins/cache/
 * 2. Link Tabby plugin into Tabby plugins dir
 * 3. Clean up legacy install artifacts
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const HOME = os.homedir()
const CLAUDE_DIR = path.join(HOME, '.claude')

// --- 1. Deploy Claude Code plugin ---

function deployCCPlugin () {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const version = pkg.version || '0.1.0'

  const cacheDir = path.join(CLAUDE_DIR, 'plugins', 'cache', 'claude-code-zit', 'zit', version)

  fs.mkdirSync(path.join(cacheDir, '.claude-plugin'), { recursive: true })
  fs.mkdirSync(path.join(cacheDir, 'hooks'), { recursive: true })

  fs.copyFileSync(
    path.join(ROOT, 'plugin', '.claude-plugin', 'plugin.json'),
    path.join(cacheDir, '.claude-plugin', 'plugin.json'),
  )
  fs.copyFileSync(
    path.join(ROOT, 'plugin', 'hooks', 'hooks.json'),
    path.join(cacheDir, 'hooks', 'hooks.json'),
  )
  fs.copyFileSync(
    path.join(ROOT, 'bin', 'claude-code-zit-hook.js'),
    path.join(cacheDir, 'claude-code-zit-hook.js'),
  )

  // Remove orphan marker if present
  const orphan = path.join(cacheDir, '.orphaned_at')
  if (fs.existsSync(orphan)) {
    fs.unlinkSync(orphan)
    console.log('Removed orphan marker')
  }

  console.log(`Claude Code plugin deployed: ${cacheDir}`)
}

// --- 2. Link Tabby plugin ---

function linkTabbyPlugin () {
  const appData = process.env.APPDATA
  if (!appData) {
    console.log('APPDATA not set — skipping Tabby link (not Windows?)')
    return
  }

  const nodeModulesDir = path.join(appData, 'tabby', 'plugins', 'node_modules')
  const dest = path.join(nodeModulesDir, 'tabby-claude-code-zit')

  fs.mkdirSync(nodeModulesDir, { recursive: true })

  if (fs.existsSync(dest)) {
    let stat
    try { stat = fs.lstatSync(dest) } catch { stat = null }
    if (stat?.isSymbolicLink?.() || (stat && isJunction(dest))) {
      console.log(`Tabby plugin already linked: ${dest}`)
      return
    }
    // Existing dir — update in place
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dest, 'package.json'))
    const distDest = path.join(dest, 'dist')
    if (fs.existsSync(distDest)) {
      fs.rmSync(distDest, { recursive: true, force: true })
    }
    copyDirSync(path.join(ROOT, 'dist'), distDest)
    // Also update bin/ and plugin/
    copyDirSync(path.join(ROOT, 'bin'), path.join(dest, 'bin'))
    copyDirSync(path.join(ROOT, 'plugin'), path.join(dest, 'plugin'))
    console.log(`Tabby plugin updated: ${dest}`)
    return
  }

  // Create junction (no admin required on Windows)
  try {
    fs.symlinkSync(ROOT, dest, 'junction')
    console.log(`Tabby plugin linked: ${dest} -> ${ROOT}`)
  } catch (e) {
    console.error(`Failed to create junction: ${e.message}`)
    console.log('Falling back to copy...')
    copyDirSync(ROOT, dest, ['node_modules', '.git'])
    console.log(`Tabby plugin copied: ${dest}`)
  }
}

function isJunction (p) {
  try {
    const stat = fs.lstatSync(p)
    return stat.isSymbolicLink()
  } catch {
    return false
  }
}

function copyDirSync (src, dest, exclude = []) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src)) {
    if (exclude.includes(entry)) continue
    const s = path.join(src, entry)
    const d = path.join(dest, entry)
    const stat = fs.statSync(s)
    if (stat.isDirectory()) {
      copyDirSync(s, d, exclude)
    } else {
      fs.copyFileSync(s, d)
    }
  }
}

// --- 3. Register hooks in settings.json ---

function registerHooks () {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const version = pkg.version || '0.1.0'
  const hookScript = path.join(CLAUDE_DIR, 'plugins', 'cache', 'claude-code-zit', 'zit', version, 'claude-code-zit-hook.js')
    .replace(/\\/g, '/')

  const settingsPath = path.join(CLAUDE_DIR, 'settings.json')
  if (!fs.existsSync(settingsPath)) return

  try {
    const raw = fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '')
    const settings = JSON.parse(raw)

    // Remove broken enabledPlugins entry if present
    if (settings.enabledPlugins && settings.enabledPlugins['troshab@claude-code-zit'] !== undefined) {
      delete settings.enabledPlugins['troshab@claude-code-zit']
    }

    if (!settings.hooks || typeof settings.hooks !== 'object') {
      settings.hooks = {}
    }

    const hookEvents = {
      SessionStart: 'session_start',
      PreToolUse: 'tool_start',
      PostToolUse: 'tool_end',
      Stop: 'stop',
      Notification: 'notification',
      SessionEnd: 'session_end',
    }

    let modified = false
    for (const [eventName, eventArg] of Object.entries(hookEvents)) {
      if (!Array.isArray(settings.hooks[eventName])) {
        settings.hooks[eventName] = []
      }

      // Check if our hook is already registered
      const alreadyRegistered = settings.hooks[eventName].some(entry =>
        Array.isArray(entry?.hooks) && entry.hooks.some(h =>
          String(h?.command ?? '').includes('claude-code-zit-hook')
        )
      )
      if (alreadyRegistered) continue

      settings.hooks[eventName].push({
        hooks: [{
          type: 'command',
          command: `node "${hookScript}" --hook --event ${eventArg}`,
          timeout: 10000,
        }],
      })
      modified = true
    }

    if (modified) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      fs.copyFileSync(settingsPath, `${settingsPath}.bak-${ts}`)
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8')
      console.log('Hooks registered in settings.json')
    } else {
      console.log('Hooks already registered in settings.json')
    }
  } catch (e) {
    console.log(`Warning: could not update settings.json: ${e.message}`)
  }
}

// --- 4. Clean up legacy files ---

function cleanupLegacy () {
  const legacyFiles = [
    path.join(CLAUDE_DIR, 'hooks', 'claude-code-zit-hook.js'),
    path.join(CLAUDE_DIR, 'hooks', 'claude-code-zit.cmd'),
  ]
  for (const f of legacyFiles) {
    if (fs.existsSync(f)) {
      fs.unlinkSync(f)
      console.log(`Removed legacy: ${f}`)
    }
  }
}

// --- Run ---

try {
  deployCCPlugin()
  registerHooks()
  linkTabbyPlugin()
  cleanupLegacy()
  console.log('\nDone. Restart Claude Code + Tabby to activate.')
} catch (e) {
  console.error(`Install failed: ${e.message}`)
  process.exit(1)
}
