#!/usr/bin/env node
/**
 * Uninstall claude-dock:
 * 1. Remove Claude Code plugin from cache
 * 2. Remove from enabledPlugins in settings.json
 * 3. Remove Tabby plugin link/copy
 * 4. Clean up legacy artifacts from settings.json
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const HOME = os.homedir()
const CLAUDE_DIR = path.join(HOME, '.claude')

/** Resolve Tabby plugins directory for the current platform. */
function tabbyPluginsDir () {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'tabby', 'plugins')
  }
  if (process.platform === 'darwin') {
    return path.join(HOME, 'Library', 'Application Support', 'tabby', 'plugins')
  }
  // Linux / FreeBSD
  return path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'tabby', 'plugins')
}

function removeCCPlugin () {
  // Remove both old and new plugin cache dirs
  for (const name of ['claude-dock', 'claude-code-zit', 'troshab-claude-code', 'troshab-kit']) {
    const pluginBase = path.join(CLAUDE_DIR, 'plugins', 'cache', name)
    if (fs.existsSync(pluginBase)) {
      fs.rmSync(pluginBase, { recursive: true, force: true })
      console.log(`Removed Claude Code plugin: ${pluginBase}`)
    }
  }
}

function unregisterPlugin () {
  const settingsPath = path.join(CLAUDE_DIR, 'settings.json')
  if (!fs.existsSync(settingsPath)) return

  try {
    const raw = fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '')
    const settings = JSON.parse(raw)
    if (!settings.enabledPlugins) return

    let modified = false
    const keysToRemove = [
      'claude-dock@claude-dock',
      'troshab@troshab-claude-code',
      'troshab@troshab-kit',
    ]
    for (const key of keysToRemove) {
      if (settings.enabledPlugins[key] !== undefined) {
        delete settings.enabledPlugins[key]
        modified = true
        console.log(`Removed from enabledPlugins: ${key}`)
      }
    }

    if (modified) {
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8')
    }
  } catch (e) {
    console.log(`Warning: could not update settings.json: ${e.message}`)
  }
}

function unlinkTabbyPlugin () {
  // Remove both old and new Tabby plugin dirs
  for (const name of ['tabby-claude-dock', 'tabby-claude-code-zit']) {
    const dest = path.join(tabbyPluginsDir(), 'node_modules', name)
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

  // Remove claude-dock and claude-code-zit hook entries from settings.json
  const settingsPath = path.join(CLAUDE_DIR, 'settings.json')
  if (!fs.existsSync(settingsPath)) return

  try {
    const raw = fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '')
    const settings = JSON.parse(raw)
    if (!settings.hooks || typeof settings.hooks !== 'object') return

    let modified = false
    for (const eventName of Object.keys(settings.hooks)) {
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
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8')
      console.log('Cleaned hooks from settings.json')
    }
  } catch (e) {
    console.log(`Warning: could not clean settings.json: ${e.message}`)
  }
}

function killDaemon () {
  const pidFile = path.join(HOME, '.claude', 'claude-dock', 'daemon.pid')
  const portFile = path.join(HOME, '.claude', 'claude-dock', 'daemon.port')
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
    if (pid) {
      try { process.kill(pid, 'SIGTERM') } catch {}
      console.log(`Stopped daemon (PID ${pid})`)
    }
  } catch {}
  try { fs.unlinkSync(pidFile) } catch {}
  try { fs.unlinkSync(portFile) } catch {}
}

try {
  killDaemon()
  removeCCPlugin()
  unregisterPlugin()
  unlinkTabbyPlugin()
  cleanupLegacy()
  console.log('\nDone. claude-dock uninstalled.')
} catch (e) {
  console.error(`Uninstall failed: ${e.message}`)
  process.exit(1)
}
