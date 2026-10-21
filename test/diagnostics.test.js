'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { memoryReport } = require('../src/diagnostics');

// A fake /proc: the container's real one has the pool under supervisord, not
// under the node process, so only reading node's own children would hide it.
function fakeProc(entries) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pyrock-proc-'));
    for (const [pid, { ppid, cmdline, rss }] of Object.entries(entries)) {
        const dir = path.join(root, pid);
        fs.mkdirSync(dir);
        const comm = cmdline.includes(' ') ? cmdline.slice(0, cmdline.indexOf(' ')) : cmdline;
        fs.writeFileSync(path.join(dir, 'stat'), `1 (${comm}) S ${ppid} 1 0 0 -1 0`);
        fs.writeFileSync(path.join(dir, 'cmdline'), `${cmdline}\0`);
        fs.writeFileSync(path.join(dir, 'status'), `Name:\t${comm}\nVmRSS:\t${Math.round(rss / 1024)} kB\n`);
    }
    return root;
}

test('every readable process is listed and classified, not only the children of node', () => {
    const root = fakeProc({
        1: { ppid: 0, cmdline: '/usr/bin/supervisord', rss: 20 * 1024 * 1024 },
        100: { ppid: 1, cmdline: 'node /app/server.js', rss: 199 * 1024 * 1024 },
        200: { ppid: 1, cmdline: '/app/.venv/bin/proxy-scraper --serve', rss: 118 * 1024 * 1024 },
        300: { ppid: 100, cmdline: '/opt/camoufox/firefox/firefox -profile', rss: 1024 * 1024 * 1024 },
        400: { ppid: 300, cmdline: 'Xvfb :99 -screen 0 1366x768x24', rss: 62 * 1024 * 1024 }
    });
    const report = memoryReport({ root, self: 999 });
    const names = report.processes.map(item => item.name).sort();
    assert.deepEqual(names, ['camoufox', 'node', 'proxy-scraper', 'supervisor', 'xvfb']);
    assert.deepEqual(report.byName, {
        camoufox: 1024, node: 199, 'proxy-scraper': 118, supervisor: 20, xvfb: 62
    }, 'the report aggregates in whole megabytes by process');
    assert.equal(
        report.total,
        report.node.rss + report.processes.reduce((sum, item) => sum + item.rss, 0),
        'the total is this node process plus everything else in the container'
    );
});

test('the node process itself is not counted twice', () => {
    const root = fakeProc({ 7: { ppid: 1, cmdline: 'node /app/server.js', rss: 50 * 1024 * 1024 } });
    const report = memoryReport({ root, self: 7 });
    assert.deepEqual(report.processes, []);
    assert.equal(report.byName.node, undefined);
});

test('a missing /proc is reported as null instead of a fake zero', () => {
    const report = memoryReport({ root: path.join(os.tmpdir(), 'pyrock-no-existe-proc') });
    assert.equal(report.processes, null);
    assert.equal(report.total, null);
    assert.equal(report.byName, null);
});
