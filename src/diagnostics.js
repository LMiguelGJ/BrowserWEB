'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The node process cannot see the memory of the browser it launched, so the
// real number lives in the other processes of the container: Camoufox is where
// the sections and the IP measurements consume it, and the free proxy pool runs
// beside it under supervisord. Only the resident size and a coarse name are
// reported: the command line of a process can carry a credential and is never
// exposed.
function residentBytes(pid, root) {
    try {
        const raw = fs.readFileSync(path.join(root, String(pid), 'status'), 'utf8');
        const match = /VmRSS:\s+(\d+)\s+kB/.exec(raw);
        return match ? Number(match[1]) * 1024 : null;
    } catch {
        return null;
    }
}

function classify(pid, root) {
    let cmdline = '';
    try { cmdline = fs.readFileSync(path.join(root, String(pid), 'cmdline'), 'utf8'); } catch { /* unreadable is unknown */ }
    if (/camoufox|firefox/i.test(cmdline)) return 'camoufox';
    if (/proxy-scraper/i.test(cmdline)) return 'proxy-scraper';
    if (/xvfb|x11|wayland/i.test(cmdline)) return 'xvfb';
    if (/supervisor/i.test(cmdline)) return 'supervisor';
    if (/(^|\W)node(\W|$)/i.test(cmdline)) return 'node';
    return 'other';
}

// Every readable process, not only the children of node: the free proxy pool
// runs under supervisord, so restricting the walk to this process' own children
// would hide the pool's memory. `self` is skipped because the node process is
// reported separately from its own accounting. `null` when /proc is not
// available (a local run outside Linux) instead of a fake zero.
function readProcesses({ root = '/proc', self = process.pid } = {}) {
    let entries;
    try { entries = fs.readdirSync(root); } catch { return null; }
    const processes = [];
    for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = Number(entry);
        if (pid === self) continue;
        const rss = residentBytes(pid, root);
        if (rss === null) continue;
        processes.push({ pid, name: classify(pid, root), rss });
    }
    return processes;
}

// Whole megabytes per kind, which is what an operator reads at a glance.
function aggregateByName(processes) {
    if (!processes) return null;
    const byName = {};
    for (const item of processes) byName[item.name] = (byName[item.name] || 0) + Math.round(item.rss / (1024 * 1024));
    return byName;
}

function memoryReport(options = {}) {
    const node = process.memoryUsage();
    const processes = readProcesses(options);
    const byName = aggregateByName(processes);
    return {
        node: { rss: node.rss, heapUsed: node.heapUsed, external: node.external },
        processes,
        byName,
        total: processes ? processes.reduce((sum, item) => sum + item.rss, node.rss) : null
    };
}

module.exports = { memoryReport };