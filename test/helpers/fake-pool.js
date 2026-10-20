'use strict';
// A local stand-in for the proxy-scraper pool API. It answers /pop and
// /report exactly like the real service does, so the hybrid flow can be
// exercised without touching the internet.
const http = require('node:http');

async function startPool(initial, { password = 'pw' } = {}) {
    const state = { queue: [...initial], reports: [], pops: 0, gate: null, unauthorized: 0 };
    const server = http.createServer(async (request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        const expected = `Basic ${Buffer.from(`any:${password}`).toString('base64')}`;
        if (request.headers.authorization !== expected) { state.unauthorized++; response.writeHead(401).end(); return; }
        if (url.pathname === '/pop') {
            state.pops++;
            if (state.gate) await state.gate;
            const next = state.queue.shift();
            if (!next) { response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 0, src: 'no proxy' })); return; }
            response.writeHead(200, { 'content-type': 'application/json' })
                .end(JSON.stringify({ proxy: next, url: `http://${next}`, type: 'http', https: true }));
            return;
        }
        state.reports.push(`${url.searchParams.get('proxy')}:${url.searchParams.get('ok')}`);
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"code":0}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    state.url = `http://127.0.0.1:${server.address().port}`;
    state.close = () => new Promise(resolve => server.close(resolve));
    return state;
}

const postJson = (base, route, body = {}) => fetch(`${base}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
});

const waitFor = async (predicate, message, timeoutMs = 4000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(message);
};

module.exports = { startPool, postJson, waitFor };
