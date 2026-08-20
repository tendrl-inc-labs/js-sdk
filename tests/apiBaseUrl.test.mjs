// Where the client points, and how TENDRL_APP_URL is interpreted.
//
// The SDK used to hardcode https://app.tendrl.com/api with no env var, so it
// could not be pointed at a local stack without passing apiBaseUrl at every call
// site — and the quick-start never mentioned that option. These lock in the
// escape hatch and the normalisation rule shared with the Go, Python and
// nano-agent clients, so one TENDRL_APP_URL works for all of them.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshClient } from './helpers.mjs';

const ORIGINAL = process.env.TENDRL_APP_URL;
afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.TENDRL_APP_URL;
    else process.env.TENDRL_APP_URL = ORIGINAL;
});

async function baseUrlFor(envValue) {
    if (envValue === undefined) delete process.env.TENDRL_APP_URL;
    else process.env.TENDRL_APP_URL = envValue;
    const TendrlClient = await freshClient();
    return new TendrlClient({ apiKey: 'k' }).apiBaseUrl;
}

describe('TENDRL_APP_URL', () => {
    const cases = [
        ['http://localhost:8000',      'http://localhost:8000/api'],
        ['http://localhost:8000/',     'http://localhost:8000/api'],
        ['http://localhost:8000/api',  'http://localhost:8000/api'],
        ['http://localhost:8000/api/', 'http://localhost:8000/api'],
    ];

    for (const [value, expected] of cases) {
        test(`${value} -> ${expected}`, async () => {
            assert.equal(await baseUrlFor(value), expected,
                'a bare origin must get /api appended and a URL already ending in ' +
                '/api must be left alone; otherwise sharing the variable with the ' +
                'nano-agent produces .../api/api');
        });
    }

    test('defaults to production when unset', async () => {
        assert.equal(await baseUrlFor(undefined), 'https://app.tendrl.com/api');
    });

    test('an explicit apiBaseUrl beats the env var', async () => {
        process.env.TENDRL_APP_URL = 'http://from-env:1111';
        const TendrlClient = await freshClient();
        const c = new TendrlClient({ apiKey: 'k', apiBaseUrl: 'http://from-arg:2222/api' });
        assert.equal(c.apiBaseUrl, 'http://from-arg:2222/api');
    });

    test('survives an environment with no process global', async () => {
        // Browsers have no process.env. The lookup is guarded so the bundle still
        // loads there and falls back to production instead of throwing on import.
        const saved = globalThis.process;
        try {
            // eslint-disable-next-line no-global-assign
            delete globalThis.process;
            const TendrlClient = await freshClient();
            const c = new TendrlClient({ apiKey: 'k' });
            assert.equal(c.apiBaseUrl, 'https://app.tendrl.com/api');
        } finally {
            globalThis.process = saved;
        }
    });
});
