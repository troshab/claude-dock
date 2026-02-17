const fs = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/analyze-trace.js <trace.json>');
  process.exit(1);
}

const resolved = path.resolve(file);
if (!fs.existsSync(resolved)) {
  console.error('File not found:', resolved);
  process.exit(1);
}

const trace = JSON.parse(fs.readFileSync(resolved, 'utf8'));
const events = trace.traceEvents || trace;

// Find main renderer thread
const rendererThread = events.find(e => e.name === 'thread_name' && e.args && e.args.name === 'CrRendererMain');
if (!rendererThread) {
  console.error('No CrRendererMain thread found in trace');
  process.exit(1);
}
const mainPid = rendererThread.pid;
const mainTid = rendererThread.tid;
console.log('Renderer PID:', mainPid, 'TID:', mainTid);

// --- Long tasks ---
const longTasks = events.filter(e =>
  e.ph === 'X' && e.pid === mainPid && e.tid === mainTid &&
  e.name === 'RunTask' && (e.dur || 0) > 50000
);
longTasks.sort((a, b) => (b.dur || 0) - (a.dur || 0));

const totalBlocking = longTasks.reduce((s, e) => s + ((e.dur || 0) / 1000 - 50), 0);
console.log('\nLong tasks (>50ms):', longTasks.length);
console.log('Total blocking time:', totalBlocking.toFixed(0), 'ms');
console.log('Longest task:', ((longTasks[0] && longTasks[0].dur || 0) / 1000).toFixed(1), 'ms');

// --- CPU Profile ---
const chunks = events.filter(e => e.name === 'ProfileChunk' && e.pid === mainPid);
if (chunks.length === 0) {
  console.log('\nNo CPU profile data in trace.');
  process.exit(0);
}

const allNodes = new Map();
const allSamples = [];
const allTimeDeltas = [];

for (const chunk of chunks) {
  const cp = chunk.args && chunk.args.data && chunk.args.data.cpuProfile;
  if (!cp) continue;
  if (cp.nodes) for (const n of cp.nodes) allNodes.set(n.id, n);
  if (cp.samples) allSamples.push(...cp.samples);
  if (chunk.args.data.timeDeltas) allTimeDeltas.push(...chunk.args.data.timeDeltas);
}

const avgInterval = allTimeDeltas.length > 0
  ? allTimeDeltas.reduce((a, b) => a + b, 0) / allTimeDeltas.length / 1000
  : 1;

console.log('CPU profile: ' + allNodes.size + ' nodes, ' + allSamples.length + ' samples, avg interval ' + avgInterval.toFixed(2) + 'ms');

function nodeName(id) {
  const n = allNodes.get(id);
  if (!n) return 'unknown';
  const cf = n.callFrame || {};
  const fn = cf.functionName || '(idle/gc)';
  const url = (cf.url || '').split(/[/\\]/).slice(-2).join('/');
  const line = cf.lineNumber || 0;
  return fn + (url ? ' @ ' + url + ':' + line : '');
}

// Self time
const sampleCounts = {};
for (const s of allSamples) {
  sampleCounts[s] = (sampleCounts[s] || 0) + 1;
}

const sorted = Object.entries(sampleCounts).sort((a, b) => b[1] - a[1]);

console.log('\n=== Top 40 functions (self time) ===');
console.log('Samples | Est ms   | Function');
console.log('-'.repeat(110));
for (const [nodeId, count] of sorted.slice(0, 40)) {
  const ms = (count * avgInterval).toFixed(0);
  console.log(String(count).padStart(7) + ' | ' + String(ms).padStart(6) + 'ms | ' + nodeName(Number(nodeId)));
}

// Bottom-up by source file
console.log('\n=== Bottom-up: inclusive time by source file ===');
const fileTime = {};
for (const s of allSamples) {
  const visited = new Set();
  let nodeId = s;
  while (nodeId && !visited.has(nodeId)) {
    visited.add(nodeId);
    const node = allNodes.get(nodeId);
    if (!node) break;
    const url = (node.callFrame && node.callFrame.url) || '';
    if (url && !url.startsWith('node:')) {
      const short = url.split(/[/\\]/).slice(-3).join('/');
      fileTime[short] = (fileTime[short] || 0) + 1;
    }
    nodeId = node.parent;
  }
}

const fileSorted = Object.entries(fileTime).sort((a, b) => b[1] - a[1]);
console.log('Samples | Est ms   | File');
console.log('-'.repeat(110));
for (const [file, count] of fileSorted.slice(0, 25)) {
  const ms = (count * avgInterval).toFixed(0);
  console.log(String(count).padStart(7) + ' | ' + String(ms).padStart(6) + 'ms | ' + file);
}
