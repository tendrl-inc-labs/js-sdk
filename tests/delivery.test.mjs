// The core promise: a published message reaches the server.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, freshClient } from './helpers.mjs';

let server;
let TendrlClient;
const clients = [];

before(async () => {
    server = await startServer();
    process.env.TENDRL_APP_URL = server.url;
    TendrlClient = await freshClient();
});

after(async () => {
    for (const c of clients) { try { c.stop?.(); } catch {} }
    await server.close();
});

beforeEach(() => { server.requests.length = 0; server.postStatus = 200; });

function makeClient(opts = {}) {
    const c = new TendrlClient({ apiKey: 'test-key', ...opts });
    clients.push(c);
    c.start();
    return c;
}

describe('publishing', () => {
    test('a published message reaches the server', async () => {
        const c = makeClient();
        await c.publish({ marker: 'basic', temperature: 23.5 }, ['sensor']);
        assert.ok(await server.waitForMarker('basic'),
            'publish() resolved but the server never received the message');
    });

    test('the payload survives the round trip', async () => {
        const c = makeClient();
        await c.publish({ marker: 'payload', temperature: 23.5, humidity: 65 }, ['sensor']);
        assert.ok(await server.waitForMarker('payload'));

        const sent = server.messages().find((m) => m?.data?.marker === 'payload');
        assert.equal(sent.data.temperature, 23.5);
        assert.equal(sent.data.humidity, 65);
    });

    test('tags are sent as context.tags', async () => {
        const c = makeClient();
        await c.publish({ marker: 'tagged' }, ['sensor', 'environment']);
        assert.ok(await server.waitForMarker('tagged'));

        const sent = server.messages().find((m) => m?.data?.marker === 'tagged');
        assert.deepEqual(sent.context?.tags, ['sensor', 'environment'],
            'tags did not arrive as context.tags — tags are what route a message to ' +
            'flows and connectors, so losing them silently breaks routing');
    });

    test('msg_type is publish', async () => {
        const c = makeClient();
        await c.publish({ marker: 'typed' }, ['sensor']);
        assert.ok(await server.waitForMarker('typed'));
        const sent = server.messages().find((m) => m?.data?.marker === 'typed');
        assert.equal(sent.msg_type, 'publish');
    });

    test('the bearer token is sent', async () => {
        const c = makeClient({ apiKey: 'sekrit-key' });
        await c.publish({ marker: 'auth' }, ['sensor']);
        assert.ok(await server.waitForMarker('auth'));

        const withAuth = server.requests.filter((r) => r.headers.authorization);
        assert.ok(withAuth.length > 0, 'no Authorization header was ever sent');
        assert.equal(withAuth[0].headers.authorization, 'Bearer sekrit-key');
    });

    test('batching drops nothing', async () => {
        const c = makeClient();
        for (let i = 0; i < 25; i++) await c.publish({ marker: `bulk-${i}` }, ['sensor']);
        for (let i = 0; i < 25; i++) {
            assert.ok(await server.waitForMarker(`bulk-${i}`), `bulk-${i} never arrived`);
        }
    });
});
