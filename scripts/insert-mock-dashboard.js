#!/usr/bin/env node
// Inject mock sessions into the Claude Dock dashboard via Chrome DevTools Protocol.
// Requires Tabby running with --remote-debugging-port=9222.
// Zero external dependencies - uses raw HTTP upgrade for WebSocket.
//
// Usage:
//   node scripts/insert-mock-dashboard.js            # 12 sessions, 4 projects (realistic)
//   node scripts/insert-mock-dashboard.js 50 8       # 50 sessions, 8 projects
//   node scripts/insert-mock-dashboard.js clear       # remove mock data

const http = require('http')
const crypto = require('crypto')

const CDP_HOST = '127.0.0.1'
const CDP_PORT = 9222

const sessionCount = process.argv[2] === 'clear' ? 0 : parseInt(process.argv[2], 10) || 12
const projectCount = parseInt(process.argv[3], 10) || 4
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
        const home = require('os').homedir().replace(/\\\\/g, '/');
        const bases = [
          home + '/claude-dock',
          home + '/projects/web-app',
          home + '/projects/api-server',
          home + '/work/dashboard',
          home + '/experiments/ml-pipeline',
          home + '/freelance/client-portal',
          home + '/oss/react-components',
          home + '/tools/cli-utils',
          home + '/research/llm-bench',
          home + '/infra/deploy-scripts',
        ];
        for (let i = 0; i < ${projectCount}; i++) {
          projects.push(bases[i % bases.length]);
        }

        const tools = ['Read', 'Edit', 'Bash', 'Grep', 'Write', 'Glob', 'Task', 'WebSearch', 'WebFetch'];
        const now = Date.now();

        // Session title patterns
        const titlePatterns = [
          (i) => 'Task ' + i + ': fix bug #' + (100 + i),
          (i) => 'Refactor auth module',
          (i) => 'Add unit tests for parser',
          (i) => 'Implement dark mode toggle',
          (i) => 'Upgrade deps to latest',
          (i) => null,  // no title - shows session id
          (i) => 'Review PR #' + (200 + i),
          (i) => 'Debug memory leak',
          (i) => 'Setup CI/CD pipeline',
          (i) => 'Migrate to TypeScript',
        ];

        const models = ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001', 'claude-opus-4-6'];

        // Realistic hook states showcasing ALL interactive features.
        // Each session is densely populated - fewer sessions, more detail per session.
        const hookStates = [
          // 0: SHOWCASE - Docker + bypass + agent team + subagent todos (waiting: agent asked question)
          { status: 'waiting', title: 'Full-stack auth + RBAC',
            activeSubagents: 3, lastSubagentType: 'builder',
            currentActivity: null,
            lastMessage: 'Architecture review ready. Should I proceed with JWT-based auth or switch to session-based auth for better SSR compatibility?',
            lastPrompt: 'Implement full authentication system with role-based access control. Use JWT, add admin/user roles, guard all API routes.',
            lastError: null, isInterrupt: false,
            permissionPending: null, lastFailedTool: null,
            isDocker: true, mountClaudeDir: true, forwardPorts: [3000, 5432],
            subagentTranscripts: [
              { type: 'builder', path: home + '/.claude/projects/auth/subagent-builder-1.jsonl' },
              { type: 'reviewer', path: home + '/.claude/projects/auth/subagent-reviewer-1.jsonl' },
              { type: 'tester', path: home + '/.claude/projects/auth/subagent-tester-1.jsonl' },
            ],
            compactCount: 3, tasksCompleted: 8, teammateIdle: false,
            lastHookType: 'agent', permissionMode: 'bypassPermissions',
            teamName: 'auth-team', teammateName: 'builder',
            lastTaskSubject: 'Add RBAC route guards for admin endpoints', compactTrigger: 'auto',
            agentType: 'builder' },
          // 1: PERMISSION REQUEST - Bash rm -rf with Allow/Deny buttons
          { status: 'waiting', title: 'Clean build and deploy',
            activeSubagents: 0, lastSubagentType: null,
            currentActivity: '$ rm -rf dist/ node_modules/.cache && npm run build',
            lastMessage: null,
            lastPrompt: 'Clean build the project, run tests, and deploy to staging.',
            lastError: null, isInterrupt: false,
            permissionPending: 'Bash', lastFailedTool: null,
            permissionRequestId: 'perm-' + crypto.randomUUID().slice(0, 8),
            permissionDetail: '$ rm -rf dist/ node_modules/.cache && npm run build',
            lastToolResponse: '> rimraf dist\\n\\n> tsc -p tsconfig.json\\n\\nCompiled successfully in 3.2s',
            compactCount: 1, tasksCompleted: 2, teammateIdle: false,
            lastHookType: 'command', permissionMode: 'default',
            teamName: null, teammateName: null,
            lastTaskSubject: 'Run lint and type checks', compactTrigger: null,
            agentType: null },
          // 2: WORKING - Builder agent with 3 Bash subagents, rich state
          { status: 'working', title: 'Deploy staging environment',
            activeSubagents: 3, lastSubagentType: 'Bash',
            currentActivity: '$ docker compose -f docker-compose.staging.yml up -d --build',
            lastMessage: null,
            lastPrompt: 'Set up staging environment with Docker. Configure nginx reverse proxy and SSL certs.',
            lastError: null, isInterrupt: false,
            permissionPending: null, lastFailedTool: null,
            lastToolResponse: 'Container staging-nginx  Started\\nContainer staging-api   Started\\nContainer staging-db    Started',
            subagentTranscripts: [
              { type: 'Bash', path: home + '/.claude/projects/infra/subagent-build-1.jsonl' },
              { type: 'Bash', path: home + '/.claude/projects/infra/subagent-build-2.jsonl' },
              { type: 'Explore', path: home + '/.claude/projects/infra/subagent-explore-1.jsonl' },
            ],
            compactCount: 1, tasksCompleted: 4, teammateIdle: false,
            lastHookType: 'prompt', permissionMode: 'bypassPermissions',
            teamName: 'infra-team', teammateName: 'builder',
            lastTaskSubject: 'Configure nginx reverse proxy', compactTrigger: 'manual',
            agentType: 'builder' },
          // 3: TEAMMATE IDLE - Reviewer done, waiting for builder. Continue button
          { status: 'waiting', title: 'Review PR #142: Auth refactor',
            activeSubagents: 0, lastSubagentType: null,
            currentActivity: null,
            lastMessage: 'Code review complete. Found 3 issues: missing null check in handleAuth(), unused import in utils.ts, hardcoded timeout in api.service.ts.',
            lastPrompt: 'Review PR #142 for security issues, unused imports, and error handling gaps.',
            lastError: null, isInterrupt: false,
            permissionPending: null, lastFailedTool: null,
            teammateIdleRequestId: 'tmid-' + crypto.randomUUID().slice(0, 8),
            compactCount: 0, tasksCompleted: 1, teammateIdle: true,
            lastHookType: 'agent', permissionMode: 'default',
            teamName: 'review-team', teammateName: 'reviewer',
            lastTaskSubject: 'Review authentication module', compactTrigger: null,
            agentType: null },
          // 4: TASK COMPLETED - Accept/Reject buttons with detail + description
          { status: 'waiting', title: 'Optimize bundle size',
            activeSubagents: 0, lastSubagentType: null,
            currentActivity: null,
            lastMessage: 'All tasks complete. 47/47 tests passing. Bundle size: 245KB (down from 312KB). Ready for review.',
            lastPrompt: 'Optimize bundle size by implementing tree-shaking and removing unused dependencies.',
            lastError: null, isInterrupt: false,
            permissionPending: null, lastFailedTool: null,
            taskCompletedRequestId: 'task-' + crypto.randomUUID().slice(0, 8),
            taskCompletedDetail: 'Remove unused lodash imports and enable tree-shaking',
            taskDescription: 'Audit all lodash imports, replace with native JS equivalents where possible, configure webpack sideEffects for remaining imports, verify bundle size reduction with webpack-bundle-analyzer.',
            lastToolResponse: 'dist/main.js  245.3 KB (gzip: 68.1 KB)\\ndist/vendor.js  112.7 KB (gzip: 31.4 KB)',
            compactCount: 3, tasksCompleted: 7, teammateIdle: false,
            lastHookType: 'agent', permissionMode: 'default',
            teamName: 'build-team', teammateName: null,
            lastTaskSubject: 'Remove unused lodash imports', compactTrigger: 'auto',
            agentType: null },
          // 5: WORKING - Plan subagent designing architecture, deep session
          { status: 'working', title: 'Multi-tenant database refactor',
            activeSubagents: 1, lastSubagentType: 'Plan',
            currentActivity: 'Plan: Design migration strategy for database schema v3',
            lastMessage: null,
            lastPrompt: 'Refactor the database layer to support multi-tenant architecture with row-level security.',
            lastError: null, isInterrupt: false,
            permissionPending: null, lastFailedTool: null,
            compactCount: 2, tasksCompleted: 5, teammateIdle: false,
            lastHookType: 'command', permissionMode: 'bypassPermissions',
            teamName: null, teammateName: null,
            lastTaskSubject: 'Migrate users table to new schema', compactTrigger: 'auto',
            agentType: null },
          // 6: PERMISSION REQUEST - Write to .env (sensitive file)
          { status: 'waiting', title: 'Configure production env',
            activeSubagents: 0, lastSubagentType: null,
            currentActivity: 'Writing .env.production',
            lastMessage: null,
            lastPrompt: 'Configure production environment variables for the deployment.',
            lastError: null, isInterrupt: false,
            permissionPending: 'Write', lastFailedTool: null,
            permissionRequestId: 'perm-' + crypto.randomUUID().slice(0, 8),
            permissionDetail: 'Write .env.production',
            compactCount: 0, tasksCompleted: 2, teammateIdle: false,
            lastHookType: 'command', permissionMode: 'default',
            teamName: null, teammateName: null,
            lastTaskSubject: 'Set up database connection string', compactTrigger: null,
            agentType: null },
          // 7: WORKING - Bash failed, agent retrying with error shown
          { status: 'working', title: 'Fix auth test failures',
            activeSubagents: 0, lastSubagentType: null,
            currentActivity: 'Editing src/services/auth.service.ts',
            lastMessage: null,
            lastPrompt: 'Fix the failing tests in the auth module. Focus on token expiry edge cases.',
            lastError: 'Command failed: npm test -- --testPathPattern=auth (exit code 1). 2 of 12 tests failed: TokenExpiry, RefreshFlow.',
            lastToolResponse: 'FAIL src/services/__tests__/auth.test.ts\\n  x TokenExpiry: expected token to be invalid after 3600s (42ms)\\n  x RefreshFlow: refresh token not rotated on reuse (18ms)',
            isInterrupt: false,
            permissionPending: null, lastFailedTool: 'Bash',
            compactCount: 0, tasksCompleted: 0, teammateIdle: false,
            lastHookType: 'prompt', permissionMode: 'plan',
            teamName: null, teammateName: null,
            lastTaskSubject: null, compactTrigger: null,
            agentType: null },
          // 8: SUBAGENT STOP - Subagent wants to stop, Continue button
          { status: 'waiting', title: 'Security audit: auth layer',
            activeSubagents: 1, lastSubagentType: 'Explore',
            currentActivity: null,
            lastMessage: 'Explore agent completed scan of 47 files. Found 2 potential issues: unvalidated JWT in /api/webhook, missing rate limit on /auth/login.',
            lastPrompt: 'Find all authentication-related code and identify potential security vulnerabilities.',
            lastError: null, isInterrupt: false,
            permissionPending: null, lastFailedTool: null,
            subagentStopRequestId: 'sub-' + crypto.randomUUID().slice(0, 8),
            compactCount: 0, tasksCompleted: 0, teammateIdle: false,
            lastHookType: 'agent', permissionMode: 'dontAsk',
            teamName: null, teammateName: null,
            lastTaskSubject: null, compactTrigger: null,
            agentType: null },
          // 9: WORKING - Team orchestration, 2 Explore subagents mid-flight
          { status: 'working', title: 'Migrate to TypeScript strict mode',
            activeSubagents: 2, lastSubagentType: 'Explore',
            currentActivity: 'Grep "any|@ts-ignore|@ts-expect-error" in src/**/*.ts',
            lastMessage: null,
            lastPrompt: 'Enable strict mode in tsconfig and fix all resulting type errors across the codebase.',
            lastError: null, isInterrupt: false,
            permissionPending: null, lastFailedTool: null,
            lastToolResponse: 'src/utils.ts:42: const data: any = response.json()\\nsrc/api.ts:18: // @ts-ignore legacy code\\nsrc/types.ts:7: export type Config = any',
            subagentTranscripts: [
              { type: 'Explore', path: home + '/.claude/projects/ts-strict/subagent-explore-1.jsonl' },
              { type: 'Explore', path: home + '/.claude/projects/ts-strict/subagent-explore-2.jsonl' },
            ],
            compactCount: 1, tasksCompleted: 3, teammateIdle: false,
            lastHookType: 'command', permissionMode: 'acceptEdits',
            teamName: 'ts-migration', teammateName: 'builder',
            lastTaskSubject: 'Fix strict null checks in services/', compactTrigger: 'auto',
            agentType: 'builder' },
          // 10: WORKING - Multi-agent migration, 3 subagents
          { status: 'working', title: 'Microservices migration',
            activeSubagents: 3, lastSubagentType: 'Bash',
            currentActivity: '$ npm run test -- --coverage',
            lastMessage: null,
            lastPrompt: 'Migrate the monolith into microservices. Split auth, billing, and notifications into separate services with shared proto definitions.',
            lastError: null, isInterrupt: false,
            permissionPending: null, lastFailedTool: null,
            lastToolResponse: 'Tests: 142 passed, 3 failed\\nCoverage: 87.4% statements, 79.1% branches',
            subagentTranscripts: [
              { type: 'Bash', path: home + '/.claude/projects/migration/subagent-build-1.jsonl' },
              { type: 'Explore', path: home + '/.claude/projects/migration/subagent-explore-1.jsonl' },
              { type: 'Plan', path: home + '/.claude/projects/migration/subagent-plan-1.jsonl' },
            ],
            compactCount: 2, tasksCompleted: 6, teammateIdle: false,
            lastHookType: 'agent', permissionMode: 'acceptEdits',
            teamName: 'migration-team', teammateName: 'builder',
            lastTaskSubject: 'Extract billing service from monolith', compactTrigger: 'auto',
            agentType: 'builder' },
          // 11: WORKING - Simple active session reading code
          { status: 'working', title: null,
            activeSubagents: 0, lastSubagentType: null,
            currentActivity: 'Reading src/components/App.tsx',
            lastMessage: null,
            lastPrompt: null, lastError: null, isInterrupt: false,
            permissionPending: null, lastFailedTool: null,
            lastToolResponse: '{"name":"my-app","version":"2.1.0","dependencies":{"react":"^18.2.0","typescript":"^5.3.0"}}',
            compactCount: 0, tasksCompleted: 0, teammateIdle: false,
            lastHookType: 'command', permissionMode: 'default',
            teamName: null, teammateName: null,
            lastTaskSubject: null, compactTrigger: null,
            agentType: null },
        ];

        const sessions = [];
        // Explicit session-to-workspace mapping for controlled demo layout
        // Index into bases[]: ~/claude-dock=0, ~/projects/web-app=1, ~/projects/api-server=2,
        // ~/work/dashboard=3, ~/experiments/ml-pipeline=4, ~/freelance/client-portal=5
        const cwdMap = [0, 1, 2, 3, 1, 2, 3, 4, 5, 2, 3, 4];

        for (let i = 0; i < ${sessionCount}; i++) {
          const cwd = i < cwdMap.length ? bases[cwdMap[i]] : bases[i % bases.length];
          const hs = hookStates[i % hookStates.length];
          const titleFn = titlePatterns[i % titlePatterns.length];
          sessions.push({
            sessionId: 'sess-' + String(i).padStart(3, '0') + '-' + Math.random().toString(36).slice(2, 10),
            cwd,
            status: hs.status,
            title: hs.title || (titleFn ? titleFn(i) : null),
            startTs: now - (${sessionCount} - i) * 600000,
            lastEventTs: now - i * 30000,
            waitingSinceTs: hs.status === 'waiting' ? now - (${sessionCount} - i) * 60000 : undefined,
            lastToolName: tools[i % tools.length],
            lastToolTs: now - i * 15000,
            hostPid: 10000 + i,
            terminalId: 'term-' + i,
            // Extended fields
            model: models[i % models.length],
            currentActivity: hs.currentActivity || undefined,
            lastPrompt: hs.lastPrompt || undefined,
            lastError: hs.lastError || undefined,
            isInterrupt: hs.isInterrupt || undefined,
            // Hook state fields
            activeSubagents: hs.activeSubagents || undefined,
            lastSubagentType: hs.lastSubagentType || undefined,
            lastMessage: hs.lastMessage || undefined,
            permissionPending: hs.permissionPending || undefined,
            lastFailedTool: hs.lastFailedTool || undefined,
            compactCount: hs.compactCount || undefined,
            tasksCompleted: hs.tasksCompleted || undefined,
            teammateIdle: hs.teammateIdle || undefined,
            lastHookType: hs.lastHookType || undefined,
            permissionMode: hs.permissionMode !== 'default' ? hs.permissionMode : undefined,
            agentType: hs.agentType || undefined,
            teamName: hs.teamName || undefined,
            teammateName: hs.teammateName || undefined,
            lastTaskSubject: hs.lastTaskSubject || undefined,
            compactTrigger: hs.compactTrigger || undefined,
            endReason: undefined,
            // Interactive action fields (bidirectional hook controls)
            permissionRequestId: hs.permissionRequestId || undefined,
            permissionDetail: hs.permissionDetail || undefined,
            subagentStopRequestId: hs.subagentStopRequestId || undefined,
            teammateIdleRequestId: hs.teammateIdleRequestId || undefined,
            taskCompletedRequestId: hs.taskCompletedRequestId || undefined,
            taskCompletedDetail: hs.taskCompletedDetail || undefined,
            // New detail fields
            lastToolResponse: hs.lastToolResponse || undefined,
            taskDescription: hs.taskDescription || undefined,
            subagentTranscripts: hs.subagentTranscripts || undefined,
            // Docker environment labels
            isDocker: hs.isDocker || undefined,
            mountClaudeDir: hs.mountClaudeDir || undefined,
            forwardPorts: hs.forwardPorts || undefined,
          });
        }

        const wsItems = [
          { title: 'claude-dock', cwd: home + '/claude-dock' },
          { title: 'web-app', cwd: home + '/projects/web-app' },
          { title: 'api-server', cwd: home + '/projects/api-server' },
          { title: 'ml-pipeline', cwd: home + '/experiments/ml-pipeline' },
          { title: 'react-components', cwd: home + '/oss/react-components' },
          { title: 'deploy-scripts', cwd: home + '/infra/deploy-scripts' },
          { title: 'client-portal', cwd: home + '/freelance/client-portal' },
        ];
        const mockWorkspaces = wsItems.map((w, i) => ({ id: 'ws-' + i, ...w }));
        cmp.workspaces = mockWorkspaces;
        cmp.refreshWorkspaces = () => {};

        cmp.visibleRuntimeSessions = () => sessions;

        // --- Varied todo lists per session ---
        // Pattern: every 3rd session gets legacy-style todos,
        // every 5th gets TaskCreate-style todos (different content),
        // some overlap for variety.
        const todoSets = {
          legacy: [
            { content: 'Refactor auth middleware', status: 'completed' },
            { content: 'Add unit tests for parser', status: 'completed' },
            { content: 'Fix memory leak in WebSocket handler', status: 'in_progress' },
            { content: 'Update API documentation', status: 'pending' },
            { content: 'Review PR #142', status: 'pending' },
          ],
          devops: [
            { content: 'Set up CI/CD pipeline', status: 'completed' },
            { content: 'Configure Docker multi-stage build', status: 'in_progress' },
            { content: 'Add health check endpoint', status: 'in_progress' },
            { content: 'Write Terraform modules for staging', status: 'pending' },
          ],
          frontend: [
            { content: 'Implement responsive grid layout', status: 'completed' },
            { content: 'Add dark mode CSS variables', status: 'completed' },
            { content: 'Fix z-index stacking in modals', status: 'in_progress' },
            { content: 'Write E2E tests with Playwright', status: 'pending' },
            { content: 'Optimize bundle size (tree-shaking)', status: 'pending' },
            { content: 'Add i18n support for 3 languages', status: 'pending' },
          ],
          database: [
            { content: 'Migrate schema to v2', status: 'completed' },
            { content: 'Add composite index on (user_id, created_at)', status: 'in_progress' },
            { content: 'Benchmark query performance', status: 'pending' },
          ],
          research: [
            { content: 'Read papers on retrieval-augmented generation', status: 'completed' },
            { content: 'Prototype embedding search with FAISS', status: 'in_progress' },
            { content: 'Compare BM25 vs dense retrieval', status: 'in_progress' },
            { content: 'Write evaluation harness', status: 'pending' },
            { content: 'Run ablation study on chunk sizes', status: 'pending' },
          ],
        };
        const todoSetKeys = Object.keys(todoSets);

        cmp.todosFor = (s) => {
          const idx = parseInt((s.sessionId || '').split('-')[1]);
          if (isNaN(idx)) return [];
          if (idx % 5 === 4) return [];
          const setKey = todoSetKeys[idx % todoSetKeys.length];
          const pool = todoSets[setKey];
          const count = 2 + (idx % (pool.length - 1));
          return pool.slice(0, Math.min(count, pool.length));
        };

        // Mock subagent mini-todos for sessions with subagentTranscripts
        const subagentTodoSets = {
          // Tool-based subagents (for non-team sessions)
          Bash: [
            { content: 'Run integration test suite', status: 'completed' },
            { content: 'Build Docker image', status: 'in_progress' },
            { content: 'Push to registry', status: 'pending' },
          ],
          Explore: [
            { content: 'Scan src/ for type errors', status: 'completed' },
            { content: 'Check test coverage gaps', status: 'in_progress' },
          ],
          Plan: [
            { content: 'Analyze current architecture', status: 'completed' },
            { content: 'Design migration strategy', status: 'in_progress' },
            { content: 'Estimate breaking changes', status: 'pending' },
          ],
          // Team agents (for auth-team showcase)
          builder: [
            { content: 'Implement JWT token service with RS256 signing', status: 'completed' },
            { content: 'Add refresh token rotation and revocation', status: 'completed' },
            { content: 'Create auth middleware for Express routes', status: 'in_progress' },
            { content: 'Wire up RBAC permission guards', status: 'pending' },
          ],
          reviewer: [
            { content: 'Review token expiry and refresh logic', status: 'completed' },
            { content: 'Audit password hashing (bcrypt rounds)', status: 'in_progress' },
            { content: 'Check CORS and CSP headers', status: 'pending' },
          ],
          tester: [
            { content: 'Write E2E tests for login/logout flow', status: 'completed' },
            { content: 'Test role escalation edge cases', status: 'in_progress' },
            { content: 'Load test /auth/token endpoint', status: 'pending' },
          ],
        };
        cmp.subagentTodosFor = (s) => {
          if (!s.subagentTranscripts || !s.subagentTranscripts.length) return [];
          const seen = new Set();
          return s.subagentTranscripts
            .filter(sa => { if (seen.has(sa.type)) return false; seen.add(sa.type); return true; })
            .map(sa => ({ type: sa.type, todos: subagentTodoSets[sa.type] || [] }))
            .filter(sa => sa.todos.length > 0);
        };

        cmp.recompute();
        const interactive = sessions.filter(s => s.permissionRequestId || s.subagentStopRequestId || s.teammateIdleRequestId || s.taskCompletedRequestId).length;
        const groupCount = new Set(sessions.map(s => s.cwd)).size;
        return 'injected ' + sessions.length + ' sessions (' + interactive + ' interactive) into ' + groupCount + ' groups (todos: ' + todoSetKeys.join(', ') + ')';
      })()`

  const result = await cdpSend(ws, 1, 'Runtime.evaluate', { expression: injectScript })
  console.log(result.result?.value ?? JSON.stringify(result))

  ws.close()
}

main().catch(e => {
  console.error(e.message)
  process.exit(1)
})
