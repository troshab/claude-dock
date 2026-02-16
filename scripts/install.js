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

// --- 3. Clean up legacy ---

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

  // Remove claude-code-zit entries from settings.json hooks
  const settingsPath = path.join(CLAUDE_DIR, 'settings.json')
  if (!fs.existsSync(settingsPath)) return

  try {
    const raw = fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '')
    const settings = JSON.parse(raw)
    if (!settings.hooks || typeof settings.hooks !== 'object') return

    let modified = false
    const events = ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification', 'SessionEnd']

    for (const eventName of events) {
      const arr = settings.hooks[eventName]
      if (!Array.isArray(arr)) continue

      const filtered = arr.filter(matcherEntry => {
        if (!Array.isArray(matcherEntry?.hooks)) return true
        matcherEntry.hooks = matcherEntry.hooks.filter(h => {
          const cmd = String(h?.command ?? '')
          return !cmd.includes('claude-code-zit')
        })
        return matcherEntry.hooks.length > 0
      })

      if (filtered.length !== arr.length) {
        settings.hooks[eventName] = filtered
        modified = true
      }
    }

    if (modified) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      fs.copyFileSync(settingsPath, `${settingsPath}.bak-${ts}`)
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8')
      console.log('Cleaned legacy hooks from settings.json')
    }
  } catch (e) {
    console.log(`Warning: could not clean settings.json: ${e.message}`)
  }
}

// --- Run ---

try {
  deployCCPlugin()
  linkTabbyPlugin()
  cleanupLegacy()
  console.log('\nDone. Restart Claude Code + Tabby to activate.')
} catch (e) {
  console.error(`Install failed: ${e.message}`)
  process.exit(1)
}
