#!/usr/bin/env node
// Inject mock sessions into the Claude Dock dashboard via Chrome DevTools Protocol.
// Requires Tabby running with --remote-debugging-port=9222.
// Zero external dependencies - uses raw HTTP upgrade for WebSocket.
//
// Usage:
//   node scripts/insert-mock-dashboard.js            # 30 sessions, 5 projects
//   node scripts/insert-mock-dashboard.js 100 10     # 100 sessions, 10 projects
//   node scripts/insert-mock-dashboard.js clear       # remove mock data

const http = require('http')
const crypto = require('crypto')

const CDP_HOST = '127.0.0.1'
const CDP_PORT = 9222

const sessionCount = process.argv[2] === 'clear' ? 0 : parseInt(process.argv[2], 10) || 30
const projectCount = parseInt(process.argv[3], 10) || 5
const clearMode = process.argv[2] === 'clear'

function httpGet (url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { reject(new Error(`JSON parse: ${data.slice(0, 200)}`)) }
      })
    }).on('error', reject)
  })
}

// Minimal WebSocket client (RFC 6455) - no dependencies
function connectWs (url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const key = crypto.randomBytes(16).toString('base64')

    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    })

    req.on('upgrade', (res, socket) => {
      const listeners = new Map()
      const ws = {
        send (data) {
          const buf = Buffer.from(data)
          const mask = crypto.randomBytes(4)
          const len = buf.length
          let header
          if (len < 126) {
            header = Buffer.alloc(6)
            header[0] = 0x81
            header[1] = 0x80 | len
            mask.copy(header, 2)
          } else if (len < 65536) {
            header = Buffer.alloc(8)
            header[0] = 0x81
            header[1] = 0x80 | 126
            header.writeUInt16BE(len, 2)
            mask.copy(header, 4)
          } else {
            header = Buffer.alloc(14)
            header[0] = 0x81
            header[1] = 0x80 | 127
            header.writeBigUInt64BE(BigInt(len), 2)
            mask.copy(header, 10)
          }
          const masked = Buffer.alloc(len)
          for (let i = 0; i < len; i++) masked[i] = buf[i] ^ mask[i & 3]
          socket.write(Buffer.concat([header, masked]))
        },
        on (event, fn) {
          if (!listeners.has(event)) listeners.set(event, [])
          listeners.get(event).push(fn)
        },
        off (event, fn) {
          const fns = listeners.get(event)
          if (fns) listeners.set(event, fns.filter(f => f !== fn))
        },
        close () {
          const close = Buffer.from([0x88, 0x80, 0, 0, 0, 0])
          socket.write(close)
          socket.end()
        },
      }

      let buf = Buffer.alloc(0)
      socket.on('data', chunk => {
        buf = Buffer.concat([buf, chunk])
        while (buf.length >= 2) {
          const fin = (buf[0] & 0x80) !== 0
          const masked = (buf[1] & 0x80) !== 0
          let payloadLen = buf[1] & 0x7f
          let offset = 2
          if (payloadLen === 126) {
            if (buf.length < 4) return
            payloadLen = buf.readUInt16BE(2)
            offset = 4
          } else if (payloadLen === 127) {
            if (buf.length < 10) return
            payloadLen = Number(buf.readBigUInt64BE(2))
            offset = 10
          }
          if (masked) offset += 4
          if (buf.length < offset + payloadLen) return
          let payload = buf.subarray(offset, offset + payloadLen)
          if (masked) {
            const maskKey = buf.subarray(offset - 4, offset)
            payload = Buffer.from(payload)
            for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3]
          }
          buf = buf.subarray(offset + payloadLen)
          if (fin) {
            const fns = listeners.get('message') || []
            for (const fn of fns) fn(payload.toString())
          }
        }
      })

      resolve(ws)
    })

    req.on('error', reject)
    req.end()
  })
}

function cdpSend (ws, id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('CDP timeout')), 10000)
    const onMessage = raw => {
      try {
        const resp = JSON.parse(raw)
        if (resp.id === id) {
          clearTimeout(timeout)
          ws.off('message', onMessage)
          if (resp.error) reject(new Error(resp.error.message))
          else resolve(resp.result)
        }
      } catch {}
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function main () {
  let pages
  try {
    pages = await httpGet(`http://${CDP_HOST}:${CDP_PORT}/json`)
  } catch {
    console.error('Cannot connect to CDP on port 9222. Is Tabby running with --remote-debugging-port=9222?')
    process.exit(1)
  }

  const page = pages.find(p => p.webSocketDebuggerUrl)
  if (!page) {
    console.error('No debuggable page found')
    process.exit(1)
  }

  const ws = await connectWs(page.webSocketDebuggerUrl)

  const injectScript = clearMode
    ? `(() => {
        const ngCore = require('@angular/core');
        const getLContext = ngCore['\\u0275getLContext'];
        const dashEl = document.querySelector('claude-dock-dashboard-tab');
        if (!dashEl) return 'no dashboard element';
        const ctx = getLContext(dashEl);
        if (!ctx?.lView) return 'no lView';
        const cmp = ctx.lView[8];
        if (!cmp?.recompute) return 'no component';
        delete cmp.visibleRuntimeSessions;
        delete cmp.refreshWorkspaces;
        delete cmp.todosFor;
        cmp.refreshWorkspaces();
        cmp.recompute();
        return 'mock data cleared';
      })()`
    : `(() => {
        const ngCore = require('@angular/core');
        const getLContext = ngCore['\\u0275getLContext'];
        const dashEl = document.querySelector('claude-dock-dashboard-tab');
        if (!dashEl) return 'no dashboard element';
        const ctx = getLContext(dashEl);
        if (!ctx?.lView) return 'no lView';
        const cmp = ctx.lView[8];
        if (!cmp?.recompute) return 'no component';

        const projects = [];
        const bases = [
          '/c/Users/tro/claude-dock',
          '/c/Users/tro/projects/web-app',
          '/c/Users/tro/projects/api-server',
          '/c/Users/tro/work/dashboard',
          '/c/Users/tro/experiments/ml-pipeline',
          '/c/Users/tro/freelance/client-portal',
          '/c/Users/tro/oss/react-components',
          '/c/Users/tro/tools/cli-utils',
          '/c/Users/tro/research/llm-bench',
          '/c/Users/tro/infra/deploy-scripts',
        ];
        for (let i = 0; i < ${projectCount}; i++) {
          projects.push(bases[i % bases.length]);
        }

        const statuses = ['waiting', 'waiting', 'working', 'working'];
        const tools = ['Read', 'Edit', 'Bash', 'Grep', 'Write', 'Glob'];
        const now = Date.now();
        const sessions = [];
        for (let i = 0; i < ${sessionCount}; i++) {
          const cwd = projects[i % projects.length];
          const status = statuses[i % statuses.length];
          sessions.push({
            sessionId: 'sess-' + String(i).padStart(3, '0') + '-' + Math.random().toString(36).slice(2, 10),
            cwd,
            status,
            title: i % 3 === 0 ? 'Task ' + i + ': fix bug #' + (100 + i) : 'sess-' + String(i).padStart(3, '0'),
            startTs: now - (${sessionCount} - i) * 600000,
            lastEventTs: now - i * 30000,
            waitingSinceTs: status === 'waiting' ? now - i * 60000 : undefined,
            lastToolName: tools[i % tools.length],
            lastToolTs: now - i * 15000,
            hostPid: 10000 + i,
            terminalId: 'term-' + i,
          });
        }

        const wsPrefixes = [
          '/c/Users/tro/projects/', '/c/Users/tro/work/',
          '/c/Users/tro/oss/', '/c/Users/tro/freelance/',
          '/c/Users/tro/experiments/', '/c/Users/tro/tools/',
          '/c/Users/tro/research/', '/c/Users/tro/infra/',
          '/c/Users/tro/apps/', '/c/Users/tro/libs/',
        ];
        const wsNames = [
          'web-app', 'api-server', 'dashboard', 'ml-pipeline', 'client-portal',
          'react-components', 'cli-utils', 'llm-bench', 'deploy-scripts', 'auth-service',
          'data-pipeline', 'mobile-app', 'admin-panel', 'docs-site', 'analytics',
          'payment-gateway', 'notification-svc', 'search-engine', 'cdn-proxy', 'config-mgr',
        ];
        const mockWorkspaces = [];
        for (let i = 0; i < 100; i++) {
          const prefix = wsPrefixes[i % wsPrefixes.length];
          const name = wsNames[i % wsNames.length] + (i >= 20 ? '-' + Math.floor(i / 20) : '');
          mockWorkspaces.push({ id: 'ws-' + i, title: name, cwd: prefix + name });
        }
        cmp.workspaces = mockWorkspaces;
        cmp.refreshWorkspaces = () => {};

        cmp.visibleRuntimeSessions = () => sessions;

        const todoTexts = [
          'Refactor auth middleware',
          'Add unit tests for parser',
          'Fix memory leak in WebSocket handler',
          'Update API documentation',
          'Review PR #142',
          'Migrate database schema',
          'Add error boundaries to React components',
          'Set up CI/CD pipeline',
        ];
        const todoStatuses = ['completed', 'completed', 'in_progress', 'pending', 'pending'];
        cmp.todosFor = (s) => {
          const idx = parseInt((s.sessionId || '').split('-')[1]);
          if (isNaN(idx) || idx % 3 !== 0) return [];
          const count = 2 + (idx % 4);
          return Array.from({ length: count }, (_, i) => ({
            content: todoTexts[(idx + i) % todoTexts.length],
            status: todoStatuses[(idx + i) % todoStatuses.length],
          }));
        };

        cmp.recompute();
        return 'injected ' + sessions.length + ' sessions into ' + projects.length + ' groups (with mock todos)';
      })()`

  const result = await cdpSend(ws, 1, 'Runtime.evaluate', { expression: injectScript })
  console.log(result.result?.value ?? JSON.stringify(result))

  ws.close()
}

main().catch(e => {
  console.error(e.message)
  process.exit(1)
})
