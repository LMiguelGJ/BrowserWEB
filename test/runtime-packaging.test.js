'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('the Docker image contains the pinned proxy service and starts through Supervisor', () => {
    const dockerfile = read('Dockerfile');
    assert.match(dockerfile, /^\s+supervisor\s*\\$/m, 'Supervisor is installed in the one runtime image');
    assert.match(dockerfile, /python3-venv/i, 'Python gets an isolated venv');
    assert.match(dockerfile, /uv pip install[\s\S]*proxy-scraper-cli==1\.30\.0/i, 'the CLI is pinned without the MCP extra');
    assert.match(dockerfile, /proxy-scraper-cli==1\.30\.0(?!\[mcp\])/i);
    assert.match(dockerfile, /COPY[^\n]*ops\//i, 'the supervisor config is in the runtime image');
    assert.match(dockerfile, /PYROCK_PROXY_MODE=hybrid/i, 'Docker defaults to the no-direct hybrid mode');
    assert.match(dockerfile, /PYROCK_PROXY_POOL_URL=http:\/\/127\.0\.0\.1:8899/i);
    assert.match(dockerfile, /CMD\s+\["supervisord"/i);
    assert.doesNotMatch(dockerfile, /CMD\s+\["node",\s*"server\.js"\]/i, 'Node is managed by Supervisor with the pool process');
});

test('Supervisor runs both services, waits for proxy-scraper first, and confines it to loopback', () => {
    const config = read('ops/supervisord.conf');
    assert.match(config, /\[program:proxy-scraper\]/);
    assert.match(config, /\[program:pyrock\]/);
    assert.match(config, /priority=10[\s\S]*?proxy-scraper|proxy-scraper[\s\S]*?priority=10/i);
    assert.match(config, /priority=20[\s\S]*?server\.js|server\.js[\s\S]*?priority=20/i);
    assert.match(config, /proxy-scraper[\s\S]*--want 1000[\s\S]*-t 12[\s\S]*--serve[\s\S]*--serve-host 127\.0\.0\.1[\s\S]*--serve-refill 1/i);
    assert.doesNotMatch(config, /--no-datacenter|--no-blocklisted|--recheck live/i, 'the quality filters that emptied the pool are gone');
    assert.doesNotMatch(config, /--serve-open|--serve-host\s+0\.0\.0\.0/);
    assert.match(config, /PROXY_SCRAPER_HOME="?\/app\/state\/data"?/);
    assert.match(config, /PROXY_SCRAPER_SERVE_PASSWORD/);
    assert.match(config, /stopasgroup=true[\s\S]*killasgroup=true/i, 'SIGTERM stops the child process tree');
    assert.doesNotMatch(config, /\[unix_http_server\]/, 'no control socket is opened without authentication');
});

test('Docker context explicitly includes ops while keeping tests, secrets and local data excluded', () => {
    const dockerignore = read('.dockerignore');
    assert.match(dockerignore, /^!ops\/$/m);
    assert.match(dockerignore, /^!ops\/\*\*$/m);
    assert.match(dockerignore, /^\*\*$/m);
    assert.match(dockerignore, /\*\*\/\.env/);
    assert.doesNotMatch(dockerignore, /^!test\/$/m);
});

test('Git ignores local user outputs while preserving the existing secret rule', () => {
    const paths = [
        '.firecrawl/cache.json', '.ruff_cache/cache.db', 'research/results/generated.json',
        'research/temp/notes.md', 'research/firecrawl/page.md', '.env'
    ];
    for (const artifact of paths) {
        const result = spawnSync('git', ['check-ignore', '--quiet', '--no-index', '--', artifact], {
            cwd: root, encoding: 'utf8'
        });
        assert.equal(result.status, 0, `${artifact} must be ignored`);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, '');
    }
});

test('README documents the hybrid proxy contract without claiming every section shares one IP', () => {
    const readme = read('README.md');
    for (const setting of [
        'proxy-scraper', 'PYROCK_PROXY_MODE', 'PYROCK_PROXY_POOL_URL',
        'PYROCK_PROXY_POOL_PASSWORD', 'PYROCK_FREE_SEARCH_TIMEOUT_MS',
        'PROXY_SCRAPER_SERVE_PASSWORD', 'PYROCK_PROXY_STICKY_BASE'
    ]) assert.ok(readme.includes(setting), `README documents ${setting}`);
    assert.doesNotMatch(readme, /Todas las secciones comparten un único proceso Chromium, así que comparten su CPU, memoria y dirección IP de red/);
});

test('local npm start remains the compatible Node entrypoint', () => {
    assert.equal(JSON.parse(read('package.json')).scripts.start, 'node server.js');
});
