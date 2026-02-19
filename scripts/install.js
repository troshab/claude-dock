#!/usr/bin/env node
/**
 * Install script for claude-dock:
 * 1. Install Claude Code plugin (hooks) into ~/.claude/plugins/cache/
 * 2. Register in enabledPlugins in ~/.claude/settings.json
 * 3. Link Tabby plugin into Tabby plugins dir
 * 4. Clean up legacy settings.json hooks
 * 5. Clean up legacy install artifacts (old claude-code-zit paths)
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const HOME = os.homedir()
const CLAUDE_DIR = path.join(HOME, '.claude')
const PLUGIN_KEY = 'claude-dock@claude-dock'

// --- helpers ---

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

function readSettings () {
  const settingsPath = path.join(CLAUDE_DIR, 'settings.json')
  if (!fs.existsSync(settingsPath)) return null
  const raw = fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '')
  return JSON.parse(raw)
}

function writeSettings (settings) {
  const settingsPath = path.join(CLAUDE_DIR, 'settings.json')
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8')
}

// --- 1. Install Claude Code plugin (hooks) ---

function installClaudePlugin () {
  const pluginSrc = path.join(ROOT, 'plugin')
  const pluginJson = path.join(pluginSrc, '.claude-plugin', 'plugin.json')

  if (!fs.existsSync(pluginJson)) {
    console.log('Warning: plugin/.claude-plugin/plugin.json not found, skipping Claude Code plugin')
    return
  }

  const meta = JSON.parse(fs.readFileSync(pluginJson, 'utf8'))
  const version = meta.version || '0.0.0'
  const cacheDir = path.join(CLAUDE_DIR, 'plugins', 'cache', 'claude-dock', 'claude-dock', version)

  // Remove old versions
  const parentDir = path.join(CLAUDE_DIR, 'plugins', 'cache', 'claude-dock', 'claude-dock')
  if (fs.existsSync(parentDir)) {
    for (const entry of fs.readdirSync(parentDir)) {
      if (entry !== version) {
        fs.rmSync(path.join(parentDir, entry), { recursive: true, force: true })
        console.log(`Removed old plugin version: ${entry}`)
      }
    }
  }

  // Copy plugin files
  fs.mkdirSync(cacheDir, { recursive: true })
  copyDirSync(pluginSrc, cacheDir)
  console.log(`Claude Code plugin installed: ${cacheDir}`)
}

// --- 2. Register in enabledPlugins ---

function registerPlugin () {
  const settingsPath = path.join(CLAUDE_DIR, 'settings.json')

  let settings
  if (fs.existsSync(settingsPath)) {
    try {
      settings = readSettings()
    } catch (e) {
      console.log(`Warning: could not parse settings.json: ${e.message}`)
      return
    }
  } else {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true })
    settings = {}
  }

  if (!settings.enabledPlugins) settings.enabledPlugins = {}

  let modified = false

  // Add claude-dock
  if (!settings.enabledPlugins[PLUGIN_KEY]) {
    settings.enabledPlugins[PLUGIN_KEY] = true
    modified = true
    console.log(`Registered plugin: ${PLUGIN_KEY}`)
  } else {
    console.log(`Plugin already registered: ${PLUGIN_KEY}`)
  }

  // Remove legacy keys
  const legacyKeys = ['troshab@troshab-claude-code', 'troshab@troshab-kit']
  for (const key of legacyKeys) {
    if (settings.enabledPlugins[key]) {
      delete settings.enabledPlugins[key]
      modified = true
      console.log(`Removed legacy plugin key: ${key}`)
    }
  }

  if (modified) {
    writeSettings(settings)
  }
}

// --- 3. Clean up legacy settings.json hooks ---

function cleanupSettingsHooks () {
  const settingsPath = path.join(CLAUDE_DIR, 'settings.json')
  if (!fs.existsSync(settingsPath)) return

  try {
    const settings = readSettings()

    let modified = false

    if (settings.hooks && typeof settings.hooks === 'object') {
      for (const eventName of Object.keys(settings.hooks)) {
        const arr = settings.hooks[eventName]
        if (!Array.isArray(arr)) continue
        const filtered = arr.filter(matcherEntry => {
          if (!Array.isArray(matcherEntry?.hooks)) return true
          matcherEntry.hooks = matcherEntry.hooks.filter(h => {
            const cmd = String(h?.command ?? '')
            return !cmd.includes('claude-dock-hook') && !cmd.includes('claude-code-zit-hook')
          })
          return matcherEntry.hooks.length > 0
        })
        if (filtered.length !== arr.length) {
          settings.hooks[eventName] = filtered.length ? filtered : undefined
          if (!filtered.length) delete settings.hooks[eventName]
          modified = true
          console.log(`Removed legacy hook from ${eventName}`)
        }
      }
    }

    if (modified) {
      writeSettings(settings)
      console.log('Settings hooks cleaned')
    }
  } catch (e) {
    console.log(`Warning: could not update settings.json: ${e.message}`)
  }
}

// --- 5. Clean up legacy files ---

function cleanupLegacy () {
  const legacyFiles = [
    path.join(CLAUDE_DIR, 'hooks', 'claude-code-zit-hook.js'),
    path.join(CLAUDE_DIR, 'hooks', 'claude-code-zit.cmd'),
    path.join(CLAUDE_DIR, 'hooks', 'claude-dock-hook.js'),
    path.join(CLAUDE_DIR, 'hooks', 'claude-dock.cmd'),
  ]
  for (const f of legacyFiles) {
    if (fs.existsSync(f)) {
      fs.unlinkSync(f)
      console.log(`Removed legacy: ${f}`)
    }
  }

  // Remove old plugin cache dirs
  for (const name of ['claude-code-zit', 'troshab-claude-code', 'troshab-kit']) {
    const oldCache = path.join(CLAUDE_DIR, 'plugins', 'cache', name)
    if (fs.existsSync(oldCache)) {
      try {
        fs.rmSync(oldCache, { recursive: true, force: true })
        console.log(`Removed old plugin cache: ${oldCache}`)
      } catch (e) {
        console.log(`Warning: could not remove old plugin cache: ${e.message}`)
      }
    }
  }

  // Remove old Tabby symlink
  const oldTabbyLink = path.join(tabbyPluginsDir(), 'node_modules', 'tabby-claude-code-zit')
  if (fs.existsSync(oldTabbyLink)) {
    try {
      const stat = fs.lstatSync(oldTabbyLink)
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(oldTabbyLink)
      } else {
        fs.rmSync(oldTabbyLink, { recursive: true, force: true })
      }
      console.log(`Removed old Tabby plugin: ${oldTabbyLink}`)
    } catch (e) {
      console.log(`Warning: could not remove old Tabby plugin: ${e.message}`)
    }
  }

  // Migrate data dir: ~/.claude/claude-code-zit/ -> ~/.claude/claude-dock/
  const oldDataDir = path.join(CLAUDE_DIR, 'claude-code-zit')
  const newDataDir = path.join(CLAUDE_DIR, 'claude-dock')
  if (fs.existsSync(oldDataDir) && !fs.existsSync(newDataDir)) {
    try {
      fs.renameSync(oldDataDir, newDataDir)
      console.log(`Migrated data dir: ${oldDataDir} -> ${newDataDir}`)
    } catch (e) {
      console.log(`Warning: could not migrate data dir: ${e.message}`)
    }
  }
}

// --- Run ---

try {
  cleanupSettingsHooks()
  cleanupLegacy()
  installClaudePlugin()
  registerPlugin()
  console.log('\nDone. Install the Tabby plugin manually from Claude Code.')
  process.exit(0)
} catch (e) {
  console.error(`Install failed: ${e.message}`)
  process.exit(1)
}
