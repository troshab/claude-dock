#!/usr/bin/env node
/**
 * Uninstall claude-dock:
 * 1. Remove Claude Code plugin from cache
 * 2. Remove Tabby plugin link/copy
 * 3. Clean up legacy artifacts from settings.json
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const HOME = os.homedir()
const CLAUDE_DIR = path.join(HOME, '.claude')

function removeCCPlugin () {
  // Remove both old and new plugin cache dirs
  for (const name of ['claude-dock', 'claude-code-zit']) {
    const pluginBase = path.join(CLAUDE_DIR, 'plugins', 'cache', name)
    if (fs.existsSync(pluginBase)) {
      fs.rmSync(pluginBase, { recursive: true, force: true })
      console.log(`Removed Claude Code plugin: ${pluginBase}`)
    }
  }
}

function unlinkTabbyPlugin () {
  const appData = process.env.APPDATA
  if (!appData) return

  // Remove both old and new Tabby plugin dirs
  for (const name of ['tabby-claude-dock', 'tabby-claude-code-zit']) {
    const dest = path.join(appData, 'tabby', 'plugins', 'node_modules', name)
    if (!fs.existsSync(dest)) continue

    try {
      const stat = fs.lstatSync(dest)
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(dest)
      } else {
        fs.rmSync(dest, { recursive: true, force: true })
      }
      console.log(`Removed Tabby plugin: ${dest}`)
    } catch (e) {
      console.log(`Warning: could not remove Tabby plugin: ${e.message}`)
    }
  }
}

function cleanupLegacy () {
  const legacyFiles = [
    path.join(CLAUDE_DIR, 'hooks', 'claude-dock-hook.js'),
    path.join(CLAUDE_DIR, 'hooks', 'claude-dock.cmd'),
    path.join(CLAUDE_DIR, 'hooks', 'claude-code-zit-hook.js'),
    path.join(CLAUDE_DIR, 'hooks', 'claude-code-zit.cmd'),
  ]
  for (const f of legacyFiles) {
    if (fs.existsSync(f)) {
      fs.unlinkSync(f)
      console.log(`Removed legacy: ${f}`)
    }
  }

  // Remove claude-dock and claude-code-zit entries from settings.json
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
          return !cmd.includes('claude-dock') && !cmd.includes('claude-code-zit')
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
      console.log('Cleaned hooks from settings.json')
    }
  } catch (e) {
    console.log(`Warning: could not clean settings.json: ${e.message}`)
  }
}

try {
  removeCCPlugin()
  unlinkTabbyPlugin()
  cleanupLegacy()
  console.log('\nDone. claude-dock uninstalled.')
} catch (e) {
  console.error(`Uninstall failed: ${e.message}`)
  process.exit(1)
}
