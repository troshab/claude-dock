#!/usr/bin/env node
/**
 * Install script for claude-dock (Tabby side only):
 * 1. Link Tabby plugin into Tabby plugins dir
 * 2. Clean up legacy settings.json hooks
 * 3. Clean up legacy install artifacts (old claude-code-zit paths)
 *
 * The Claude Code plugin (hooks) is installed via marketplace:
 *   claude plugin install --from github.com/troshab/claude-dock
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const HOME = os.homedir()
const CLAUDE_DIR = path.join(HOME, '.claude')

// --- 1. Link Tabby plugin ---

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

// --- 2. Clean up legacy settings.json hooks ---
// Hooks are delivered via marketplace plugin (plugin/hooks/hooks.json).
// This function only removes legacy hook entries from settings.json.

function cleanupSettingsHooks () {
  const settingsPath = path.join(CLAUDE_DIR, 'settings.json')
  if (!fs.existsSync(settingsPath)) return

  try {
    const raw = fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '')
    const settings = JSON.parse(raw)

    let modified = false

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

// --- 3. Clean up legacy files ---

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
  cleanupSettingsHooks()
  cleanupLegacy()
  linkTabbyPlugin()
  console.log('\nDone. Restart Tabby to activate.')
  console.log('Claude Code plugin: claude plugin install --from github.com/troshab/claude-dock')
  process.exit(0)
} catch (e) {
  console.error(`Install failed: ${e.message}`)
  process.exit(1)
}
