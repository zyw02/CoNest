// system-info component for dsh-bridge
// Read /proc filesystem and os module for system metrics (Linux-only).
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

function readProc(path) {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

async function getCpuUsage(signal) {
  const stat1 = readProc('/proc/stat');
  if (!stat1) return 0;

  const line1 = stat1.split('\n')[0].split(/\s+/).slice(1).map(Number);
  const total1 = line1.reduce((a, b) => a + b, 0);
  const idle1 = line1[3];

  await delay(100, undefined, { signal });

  const stat2 = readProc('/proc/stat');
  const line2 = stat2.split('\n')[0].split(/\s+/).slice(1).map(Number);
  const total2 = line2.reduce((a, b) => a + b, 0);
  const idle2 = line2[3];

  const totalDiff = total2 - total1;
  const idleDiff = idle2 - idle1;
  if (totalDiff === 0) return 0;
  return Math.round((1 - idleDiff / totalDiff) * 1000) / 10;
}

function getMemoryInfo() {
  const meminfo = readProc('/proc/meminfo');
  const info = {};
  for (const line of meminfo.split('\n')) {
    const match = line.match(/^(\w+):\s+(\d+)\s+kB$/);
    if (match) info[match[1]] = parseInt(match[2]) / 1024;
  }
  const total = info['MemTotal'] || 0;
  const available = info['MemAvailable'] || 0;
  const used = total - available;
  return {
    totalMB: Math.round(total),
    usedMB: Math.round(used),
    percent: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
  };
}

export default {
  name: 'system-info',
  inject: ['bridgeCapabilities'],
  apply(ctx, config) {
    ctx.bridgeCapabilities.register(ctx, 'system_metrics', async (args, invocation) => {
      invocation.progress('Reading system metrics...');

      const cpuCores = os.cpus().length;
      const cpuModel = os.cpus()[0]?.model || 'Unknown';
      const cpuUsagePercent = await getCpuUsage(invocation.signal);
      const mem = getMemoryInfo();
      const load = os.loadavg();
      const uptime = os.uptime();
      const hostname = os.hostname();

      let diskTotalGB = 0, diskUsedGB = 0, diskPercent = 0;
      try {
        const r = await run('df', ['-B1G', '/'], { encoding: 'utf8', timeout: 3000, signal: invocation.signal });
        if (r.stdout) {
          const parts = r.stdout.split('\n')[1].split(/\s+/);
          diskTotalGB = parseFloat(parts[1]) || 0;
          diskUsedGB = parseFloat(parts[2]) || 0;
          diskPercent = parseFloat(parts[4]) || 0;
        }
      } catch (error) { if (invocation.signal.aborted) throw invocation.signal.reason ?? error; }

      return {
        cpuModel,
        cpuCores,
        cpuUsagePercent,
        memoryTotalMB: mem.totalMB,
        memoryUsedMB: mem.usedMB,
        memoryPercent: mem.percent,
        diskTotalGB,
        diskUsedGB,
        diskPercent,
        loadAverage: {
          '1min': Math.round(load[0] * 100) / 100,
          '5min': Math.round(load[1] * 100) / 100,
          '15min': Math.round(load[2] * 100) / 100,
        },
        uptimeSeconds: Math.round(uptime),
        hostname,
      };
    });

    ctx.bridgeCapabilities.register(ctx, 'top_processes', async (args, invocation) => {
      const count = Math.min(args.count || 10, 20);
      invocation.progress(`Reading top ${count} processes...`);

      let processes = [];
      try {
        // comm contains the executable name; args would expose unrelated process secrets.
        const r = await run('ps', ['-eo', 'pid=,pcpu=,pmem=,rss=,comm=', '--sort=-%cpu'], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 3000, signal: invocation.signal });
        if (r.stdout) {
          const lines = r.stdout.split('\n').filter(Boolean).slice(0, count);
          for (const line of lines) {
            const match = line.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
            if (!match) continue;
            processes.push({
              pid: parseInt(match[1]),
              cpuPercent: parseFloat(match[2]),
              memPercent: parseFloat(match[3]),
              rssMB: Math.round(parseInt(match[4]) / 1024),
              name: match[5].substring(0, 80),
            });
          }
        }
      } catch (error) { if (invocation.signal.aborted) throw invocation.signal.reason ?? error; }

      return { processes };
    });
  },
};
