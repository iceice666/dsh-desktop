/**
 * Private HTTP routes behind the branding Settings page.
 *
 * They are registered on the host's own loopback `webServer`, which anything on
 * the machine can connect to. Changing the app's identity and relaunching it
 * are not things a random local process — or an ordinary browser that once
 * completed the token exchange — should be able to do, so every request must
 * pass all of:
 *
 * 1. the upstream Connection fence (`requestRejection`: signed cookie, trusted
 *    Host);
 * 2. this generation's renderer capability header, which only the Electron
 *    window's own network session attaches (see `renderer-session.js`);
 * 3. for mutations: an exact same-origin `Origin`, a JSON content type, a small
 *    body, and a body with exactly the expected keys.
 *
 * The module has no Electron dependency; `branding-controller.js` supplies the
 * operations, which keeps the request policy testable with plain objects.
 */

import { sameAccessToken } from './browser-access.js';

/** Route prefix; exact routes win over upstream's `/api` prefix route. */
export const BRANDING_API = '/api/dsh-desktop/branding';

export const BRANDING_PATHS = Object.freeze({
  state: BRANDING_API,
  icon: `${BRANDING_API}/icon`,
  name: `${BRANDING_API}/name`,
  chooseIcon: `${BRANDING_API}/icon/choose`,
  resetIcon: `${BRANDING_API}/icon/reset`,
  restart: `${BRANDING_API}/restart`,
});

const MAX_BODY_BYTES = 4 * 1024;

class RequestError extends Error {
  /**
   * @param status - HTTP status to answer with.
   * @param message - client-safe message.
   */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Build the route table.
 *
 * @param options - `{ origin, accessHeader, requestRejection, controller, log }`:
 *   the carrier origin, a function returning the live generation's
 *   `{ name, value }` capability (or `undefined` between generations), the
 *   upstream Connection fence, the operations, and a diagnostics sink.
 * @returns `[{ path, handler }]` ready for `webServer.register`.
 */
export function createBrandingRoutes(options) {
  const { controller } = options;

  /**
   * Wrap one operation with the shared admission policy.
   * @param method - the only accepted method.
   * @param run - `(body) => result`; the result is sent as JSON unless it
   *   already wrote the response (returns `undefined` after writing).
   * @param expectedKeys - exact body keys for POST.
   */
  const route = (method, run, expectedKeys = []) => async (req, res) => {
    try {
      admit(req, method, options);
      const body = method === 'POST' ? await readBody(req, expectedKeys) : undefined;
      const result = await run(body, res);
      if (result !== undefined) sendJson(res, 200, result);
    } catch (error) {
      if (error instanceof RequestError) {
        sendJson(res, error.status, { error: error.message });
        return;
      }
      options.log?.(`branding route failed: ${String(error?.message ?? error)}`);
      // Validation failures from the preferences store carry a useful,
      // non-sensitive message; anything else stays generic.
      const message = String(error?.message ?? '');
      sendJson(res, 400, {
        error: message.startsWith('dsh-desktop: ') ? message.slice(13) : 'request failed',
      });
    }
  };

  return [
    { path: BRANDING_PATHS.state, handler: route('GET', () => controller.state()) },
    {
      path: BRANDING_PATHS.icon,
      handler: route('GET', async (_body, res) => {
        const png = await controller.iconPng();
        if (png === undefined) throw new RequestError(404, 'no icon');
        res.statusCode = 200;
        res.setHeader('content-type', 'image/png');
        res.setHeader('cache-control', 'no-store');
        res.setHeader('x-content-type-options', 'nosniff');
        res.setHeader('content-length', String(png.length));
        res.end(png);
        return undefined;
      }),
    },
    {
      path: BRANDING_PATHS.name,
      handler: route(
        'POST',
        (body) => {
          if (body.name !== null && typeof body.name !== 'string') {
            throw new RequestError(400, 'name must be a string or null');
          }
          return controller.setName(body.name ?? undefined);
        },
        ['name'],
      ),
    },
    { path: BRANDING_PATHS.chooseIcon, handler: route('POST', () => controller.chooseIcon()) },
    { path: BRANDING_PATHS.resetIcon, handler: route('POST', () => controller.resetIcon()) },
    {
      path: BRANDING_PATHS.restart,
      handler: route('POST', (_body, res) => {
        // Answer first: the relaunch tears down this very server.
        sendJson(res, 202, { accepted: true });
        setImmediate(() => {
          void Promise.resolve()
            .then(() => controller.restart())
            .catch((error) => options.log?.(`relaunch failed: ${String(error)}`));
        });
        return undefined;
      }),
    },
  ];
}

/**
 * Enforce the admission policy described at the top of this file.
 * @param req - incoming request.
 * @param method - the only accepted method.
 * @param options - route options.
 * @throws {RequestError} on any failure.
 */
function admit(req, method, options) {
  if (req.method !== method) throw new RequestError(405, 'method not allowed');

  const rejection = options.requestRejection(req);
  if (rejection !== undefined) {
    throw new RequestError(rejection, rejection === 401 ? 'unauthorized' : 'forbidden');
  }

  const capability = options.accessHeader();
  if (capability === undefined) throw new RequestError(503, 'window not ready');
  const presented = req.headers[capability.name.toLowerCase()];
  if (!sameAccessToken(presented, capability.value)) throw new RequestError(403, 'forbidden');

  if (method === 'POST') {
    if (req.headers.origin !== options.origin) throw new RequestError(403, 'forbidden');
    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite !== undefined && fetchSite !== 'same-origin') {
      throw new RequestError(403, 'forbidden');
    }
  }
}

/**
 * Read and validate a JSON body.
 * @param req - incoming request.
 * @param expectedKeys - exact set of keys the body must have.
 * @returns the parsed object.
 * @throws {RequestError} on a bad content type, size, syntax, or shape.
 */
async function readBody(req, expectedKeys) {
  const type = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') throw new RequestError(415, 'content type must be application/json');

  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new RequestError(413, 'request body is too large');
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RequestError(413, 'request body is too large');
    chunks.push(chunk);
  }

  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError(400, 'invalid JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestError(400, 'body must be an object');
  }
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new RequestError(400, 'unexpected request fields');
  }
  return value;
}

/**
 * @param res - response.
 * @param status - HTTP status.
 * @param value - JSON-serialisable body.
 */
function sendJson(res, status, value) {
  if (res.headersSent) return;
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(body);
}
