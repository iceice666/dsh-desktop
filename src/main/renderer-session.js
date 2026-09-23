/**
 * Renderer session admission: the two-stage exchange that lets the desktop
 * window reach an authenticated host without ever putting the launch token in
 * page history.
 *
 * Stage 1 (`authenticateRendererSession`) performs the token exchange with
 * `session.fetch`, so the redirect and the `Set-Cookie` land in the window's own
 * persistent session while no page is loaded yet.
 *
 * Stage 2 (`installRendererAccessHeader`) attaches this generation's capability
 * to every same-origin request the renderer makes. A main-frame query string is
 * not enough: subresources, `/api` calls, and the WebSocket upgrade do not carry
 * it, and the upstream carrier checks each of those independently.
 */

/**
 * Exchange the process launch token inside the window's own session.
 *
 * `authenticatedUrl` appends the token the host accepts exactly once on `GET /`;
 * the host answers with an authority-bound signed cookie and a redirect to clean
 * `/`. Doing this through `session.fetch` rather than `loadURL` keeps the
 * tokenized URL out of the renderer's navigation history, and lets the window
 * load a clean URL afterwards.
 *
 * The host answers the tokenized request with 303 to clean `/`. `redirect:
 * 'follow'` makes the session replay that target with the cookie it just
 * stored, so a successful exchange settles as 200 on clean `/`; the intermediate
 * 303 is never surfaced here.
 *
 * @param session - the `BrowserWindow`'s partitioned session.
 * @param authenticationUrl - tokenized root URL from `connection.authenticatedUrl`.
 * @param accessHeader - this generation's renderer capability.
 */
export async function authenticateRendererSession(session, authenticationUrl, accessHeader) {
  let response;
  try {
    response = await session.fetch(authenticationUrl, {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
      headers: { [accessHeader.name]: accessHeader.value },
    });
  } catch (cause) {
    // `session.fetch` goes through Chromium's network service rather than the
    // main process's own stack. A transport-level failure here therefore says
    // nothing about the host: it is reachable over plain `fetch` whenever
    // `scripts/test-admission.mjs` passes. The usual cause is an environment
    // that blocks the network service from starting, which Chromium reports
    // earlier as "Failed to initialize sandbox".
    throw new Error(
      `dsh-desktop: the renderer session could not reach ${new URL(authenticationUrl).origin} ` +
        `(${String(cause)}). The host itself is verifiable with "pnpm test:admission"; ` +
        'a failure only here points at Chromium\'s network service, not at DSH.',
      { cause },
    );
  }
  // A 401 here means the cookie did not survive the redirect, which would leave
  // the window unable to load the origin it is about to navigate to.
  if (response.status !== 200) {
    throw new Error(
      `dsh-desktop: browser authentication failed with HTTP ${String(response.status)}`,
    );
  }
  // Release the body so the connection is not held open by an unread stream.
  await response.body?.cancel();
}

/**
 * Attach the generation capability to this renderer's same-origin traffic.
 *
 * Three independent conditions must all hold before the header is added, so a
 * redirect, a cross-origin subresource, or another `webContents` sharing the
 * session can never carry the capability off the local carrier:
 *
 * - the request belongs to this exact `webContents`;
 * - its target is the carrier's HTTP origin or the paired WebSocket origin;
 * - it originates from a frame on the carrier origin.
 *
 * Any header the page itself managed to set under this name is stripped first,
 * so the value observed by the host is always the one minted here.
 *
 * @param webContents - the renderer whose traffic is being marked.
 * @param origin - the carrier's HTTP origin.
 * @param accessHeader - this generation's renderer capability.
 * @returns idempotent disposer removing the listener.
 */
export function installRendererAccessHeader(webContents, origin, accessHeader) {
  const webSocketOrigin = pairedWebSocketOrigin(origin);
  const webRequest = webContents.session.webRequest;
  const rendererId = webContents.id;
  const headerName = accessHeader.name.toLowerCase();

  const listener = (details, callback) => {
    const requestHeaders = withoutHeader(details.requestHeaders, headerName);
    if (
      belongsToRenderer(details, rendererId) &&
      targetsCarrier(details.url, origin, webSocketOrigin) &&
      comesFromCarrierOrigin(details, origin)
    ) {
      requestHeaders[accessHeader.name] = accessHeader.value;
    }
    callback({ requestHeaders });
  };

  webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, listener);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    webRequest.onBeforeSendHeaders(null);
  };
}

/**
 * Derive the WebSocket origin paired with an HTTP origin.
 * @param origin - `http://host:port` or `https://host:port`.
 * @returns the same authority under `ws:` or `wss:`.
 */
function pairedWebSocketOrigin(origin) {
  const url = new URL(origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.origin;
}

/**
 * Copy request headers without one named header, compared case-insensitively.
 * @param requestHeaders - headers Electron is about to send.
 * @param lowerName - header name, already lowercased.
 * @returns a copy with that header removed.
 */
function withoutHeader(requestHeaders, lowerName) {
  return Object.fromEntries(
    Object.entries(requestHeaders).filter(([name]) => name.toLowerCase() !== lowerName),
  );
}

/**
 * Whether every id Electron reports for this request is our renderer.
 *
 * Requiring all reported ids to agree — rather than any — keeps a request with
 * ambiguous provenance out of the marked set.
 *
 * @param details - `onBeforeSendHeaders` details.
 * @param rendererId - the owning `webContents` id.
 * @returns whether the request is unambiguously ours.
 */
function belongsToRenderer(details, rendererId) {
  const ids = [details.webContentsId, details.webContents?.id].filter(
    (value) => value !== undefined,
  );
  return ids.length > 0 && ids.every((value) => value === rendererId);
}

/**
 * Whether the request targets the local carrier.
 * @param requestUrl - absolute request URL.
 * @param httpOrigin - carrier HTTP origin.
 * @param webSocketOrigin - paired WebSocket origin.
 * @returns whether the target is one of the two carrier origins.
 */
function targetsCarrier(requestUrl, httpOrigin, webSocketOrigin) {
  try {
    const origin = new URL(requestUrl).origin;
    return origin === httpOrigin || origin === webSocketOrigin;
  } catch {
    return false;
  }
}

/**
 * Whether the request originates from a frame on the carrier origin.
 *
 * The main frame is admitted directly because it is the navigation that
 * establishes the origin. Every other request must come from a live frame whose
 * own origin and whose top frame's origin are both the carrier.
 *
 * @param details - `onBeforeSendHeaders` details.
 * @param origin - carrier HTTP origin.
 * @returns whether the initiating frame is trusted.
 */
function comesFromCarrierOrigin(details, origin) {
  if (details.resourceType === 'mainFrame') return true;
  const frame = details.frame;
  if (frame === undefined || frame === null) return false;
  if (frame.detached || frame.origin !== origin) return false;
  const top = frame.top ?? (frame.parent === null ? frame : undefined);
  return top !== undefined && !top.detached && top.origin === origin;
}
