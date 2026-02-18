#!/usr/bin/env node
/**
 * Single install script for claude-dock:
 * 1. Deploy Claude Code plugin (hooks) to ~/.claude/plugins/cache/
 * 2. Link Tabby plugin into Tabby plugins dir
 * 3. Register hooks in settings.json
 * 4. Clean up legacy install artifacts (including old claude-code-zit paths)
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

  const cacheDir = path.join(CLAUDE_DIR, 'plugins', 'cache', 'dock', 'claude-dock', version)

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
    path.join(ROOT, 'plugin', 'claude-dock-hook.js'),
    path.join(cacheDir, 'claude-dock-hook.js'),
  )

  // Remove orphan marker if present
  const orphan = path.join(cacheDir, '.orphaned_at')
  if (fs.existsSync(orphan)) {
    fs.unlinkSync(orphan)
    console.log('Removed orphan marker')
  }

  // Register in installed_plugins.json so Claude Code treats it as installed
  const installedPath = path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json')
  try {
    let installed = { version: 2, plugins: {} }
    try { installed = JSON.parse(fs.readFileSync(installedPath, 'utf8')) } catch {}
    const key = 'claude-dock@dock'
    const entry = {
      scope: 'user',
      installPath: cacheDir.replace(/\//g, '\\'),
      version,
      installedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    }
    const existing = installed.plugins[key]
    if (!Array.isArray(existing) || existing[0]?.version !== version) {
      installed.plugins[key] = [entry]
      fs.writeFileSync(installedPath, JSON.stringify(installed, null, 2), 'utf8')
    }
  } catch (e) {
    console.log(`Warning: could not update installed_plugins.json: ${e.message}`)
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
  const dest = path.join(nodeModulesDir, 'tabby-claude-dock')

  fs.mkdirSync(nodeModulesDir, { recursive: true })

  // Check via lstat (does NOT follow symlinks) to detect broken junctions
  let lstat
  try { lstat = fs.lstatSync(dest) } catch { lstat = null }

  if (lstat) {
    if (lstat.isSymbolicLink()) {
      // Junction or symlink — check if it points to current ROOT
      let target
      try { target = fs.realpathSync(dest) } catch { target = null }
      if (target === fs.realpathSync(ROOT)) {
        console.log(`Tabby plugin already linked: ${dest}`)
        return
      }
      // Broken or stale junction — remove it
      fs.unlinkSync(dest)
      console.log(`Removed stale junction: ${dest}`)
    } else if (lstat.isDirectory()) {
      // Existing dir — update in place
      fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dest, 'package.json'))
      const distDest = path.join(dest, 'dist')
      if (fs.existsSync(distDest)) {
        fs.rmSync(distDest, { recursive: true, force: true })
      }
      copyDirSync(path.join(ROOT, 'dist'), distDest)
      copyDirSync(path.join(ROOT, 'bin'), path.join(dest, 'bin'))
      copyDirSync(path.join(ROOT, 'plugin'), path.join(dest, 'plugin'))
      console.log(`Tabby plugin updated: ${dest}`)
      return
    }
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

// --- 3. Register plugin in settings.json ---
// Hooks are delivered via plugin/hooks/hooks.json (through enabledPlugins).
// This function only ensures enabledPlugins key and cleans up legacy entries.

function registerPlugin () {
  const settingsPath = path.join(CLAUDE_DIR, 'settings.json')
  if (!fs.existsSync(settingsPath)) return

  try {
    const raw = fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '')
    const settings = JSON.parse(raw)

    let modified = false

    // Ensure our plugin is listed in enabledPlugins
    // Remove stale enabledPlugins key (old format)
    if (settings.enabledPlugins?.['troshab@claude-dock']) {
      delete settings.enabledPlugins['troshab@claude-dock']
      modified = true
    }
    // Ensure correct enabledPlugins key (marketplace format: plugin@marketplace)
    if (!settings.enabledPlugins) settings.enabledPlugins = {}
    if (!settings.enabledPlugins['claude-dock@dock']) {
      settings.enabledPlugins['claude-dock@dock'] = true
      modified = true
    }

    // Remove any leftover claude-dock hooks from settings.json (migrated to plugin hooks.json)
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
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      fs.copyFileSync(settingsPath, `${settingsPath}.bak-${ts}`)
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8')
      console.log('Settings updated')
    } else {
      console.log('Settings already up to date')
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
    path.join(CLAUDE_DIR, 'hooks', 'claude-dock-hook.js'),
    path.join(CLAUDE_DIR, 'hooks', 'claude-dock.cmd'),
  ]
  for (const f of legacyFiles) {
    if (fs.existsSync(f)) {
      fs.unlinkSync(f)
      console.log(`Removed legacy: ${f}`)
    }
  }

  // Remove old plugin cache dir
  const oldPluginCache = path.join(CLAUDE_DIR, 'plugins', 'cache', 'claude-code-zit')
  if (fs.existsSync(oldPluginCache)) {
    try {
      fs.rmSync(oldPluginCache, { recursive: true, force: true })
      console.log(`Removed old plugin cache: ${oldPluginCache}`)
    } catch (e) {
      console.log(`Warning: could not remove old plugin cache: ${e.message}`)
    }
  }

  // Remove old Tabby symlink
  const appData = process.env.APPDATA
  if (appData) {
    const oldTabbyLink = path.join(appData, 'tabby', 'plugins', 'node_modules', 'tabby-claude-code-zit')
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
  deployCCPlugin()
  registerPlugin()
  cleanupLegacy()
  linkTabbyPlugin()
  console.log('\nDone. Restart Claude Code + Tabby to activate.')
  process.exit(0)
} catch (e) {
  console.error(`Install failed: ${e.message}`)
  process.exit(1)
}
