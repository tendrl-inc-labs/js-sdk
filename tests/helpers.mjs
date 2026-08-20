// Test harness for the Tendrl JavaScript SDK.
//
// Everything runs against a local recording HTTP server, never a Tendrl stack —
// a suite that needs a live backend is a suite that gets skipped, and a skipped
// suite reports green while testing nothing.
//
// The server answers the routes the client uses and records every request, so a
// test can assert on what was actually sent rather than on the absence of a
// thrown error. publish() is asynchronous; "it did not throw" proves nothing.

import http from 'node:http';

export class Recorder {
    constructor() {
        this.requests = [];      // { path, body, headers }
        this.postStatus = 200;
    }

    messages() {
        const out = [];
        for (const r of this.requests) {
            if (!r.path.includes('message')) continue;
            if (Array.isArray(r.body)) out.push(...r.body);
            else if (r.body && typeof r.body === 'object') out.push(r.body);
        }
        return out;
    }

    markers() {
        return new Set(
            this.messages()
                .map((m) => (m && m.data && m.data.marker) || null)
                .filter(Boolean)
        );
    }

    async waitForMarker(marker, timeoutMs = 15000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (this.markers().has(marker)) return true;
            await new Promise((r) => setTimeout(r, 100));
        }
        return false;
    }
}

export async function startServer() {
    const rec = new Recorder();
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let body = null;
            try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
            if (req.method !== 'HEAD' && req.method !== 'GET') {
                rec.requests.push({ path: req.url, body, headers: req.headers });
            }
            const status = req.method === 'HEAD' || req.method === 'GET' ? 200 : rec.postStatus;
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: status, content: [] }));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    rec.url = `http://127.0.0.1:${server.address().port}`;
    rec.close = () => new Promise((resolve) => server.close(resolve));
    return rec;
}

/** Import a fresh copy of the module so module-level env reads re-run. */
export async function freshClient() {
    const mod = await import(`../src/utils/TendrlClient.js?cachebust=${Math.random()}`);
    return mod.default;
}
