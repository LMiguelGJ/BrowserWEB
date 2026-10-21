'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The node process cannot see the memory of the browser it launched, so the
// real number lives in the child processes: Camoufox is where the sections and
// the IP measurements consume it. Only the resident size and a coarse name are
// reported: the command line of a child can carry a credential and is never
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

function parentPid(pid, root) {
    try {
        const stat = fs.readFileSync(path.join(root, String(pid), 'stat'), 'utf8');
        // The command name can contain spaces and parentheses: the parent is the
        // second field after the last closing parenthesis.
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        const value = Number(fields[1]);
        return Number.isInteger(value) ? value : null;
    } catch {
        return null;
    }
}

function classify(pid, root) {
    let cmdline = '';
    try { cmdline = fs.readFileSync(path.join(root, String(pid), 'cmdline'), 'utf8'); } catch { /* unreadable is unknown */ }
    if (/camoufox|firefox/i.test(cmdline)) return 'camoufox';
    if (/proxy-scraper/i.test(cmdline)) return 'proxy-scraper';
    return 'other';
}

// The direct children of this process, with their resident memory. `null` when
// /proc is not available (a local run outside Linux) instead of a fake zero.
function childProcesses({ root = '/proc', self = process.pid } = {}) {
    let entries;
    try { entries = fs.readdirSync(root); } catch { return null; }
    const processes = [];
    for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = Number(entry);
        if (parentPid(pid, root) !== self) continue;
        const rss = residentBytes(pid, root);
        if (rss === null) continue;
        processes.push({ pid, name: classify(pid, root), rss });
    }
    return processes;
}

function memoryReport(options = {}) {
    const node = process.memoryUsage();
    const processes = childProcesses(options);
    return {
        node: { rss: node.rss, heapUsed: node.heapUsed, external: node.external },
        processes,
        total: processes ? processes.reduce((sum, item) => sum + item.rss, node.rss) : null
    };
}

module.exports = { memoryReport, childProcesses };