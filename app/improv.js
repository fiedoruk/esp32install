/**
 * Improv Wi-Fi after the install: the freshly written system can take the network name and
 * password over the same cable, so nobody has to join a setup hotspot by hand.
 *
 * The protocol client is the vendored improv-wifi-serial-sdk (`vendor/improv-wifi/`). This
 * module owns the port around it: it opens the port at 115200 once the installer has let go,
 * asks whether the device speaks Improv, and closes everything again. A device that stays
 * silent is the normal case for most systems, so `probe()` reports it and never throws; the
 * install is already done and verified by the time this runs, and nothing here can undo that.
 */
import { InstallError } from './errors.js';

const BAUD = 115200;
const PROBE_MS = 10000;      // a board needs a few seconds to boot after the reset; the client re-asks every second
const PROVISION_MS = 30000;  // joining a network can take a while on a weak signal

/** Only an http(s) address becomes a link; the device's answer is data, not markup. */
export function safeNextUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

/**
 * The client rejects with the device's error name as a plain string (`ERROR_MSGS` in
 * `const.js`), or with an Error of its own. Wrong password and out-of-range are both
 * `UNABLE_TO_CONNECT` on the device side, so they share one sentence.
 */
export function mapImprovError(reason) {
  if (reason instanceof InstallError) return reason;
  const text = String(reason?.message ?? reason ?? '');
  if (/^TIMEOUT$|not detected|timed? ?out/i.test(text)) return new InstallError('improv.timeout', {}, reason);
  if (/UNABLE_TO_CONNECT/.test(text)) return new InstallError('improv.wifi', {}, reason);
  return new InstallError('improv.rejected', { detail: text }, reason);
}

/**
 * One session over one port. `loadClient` returns the module that exports `ImprovSerial`; it
 * is injected so a page whose vendored copy is missing reports "not offered" instead of failing.
 */
export function createImprovSession({ port, loadClient, log = () => {}, baudRate = BAUD }) {
  let client = null, opened = false, closed = false, pending = Promise.resolve();
  const say = (line) => { try { log('improv: ' + line); } catch { /* the log is never ours to fix */ } };
  const logger = {
    log: (m) => say(String(m)),
    error: (m, e) => say(String(m) + (e !== undefined ? ': ' + String(e?.message ?? e) : '')),
    debug: () => {}, // one line per packet; too much for the technical log
  };
  const detail = (e) => String(e?.message ?? e ?? '');
  // Every operation goes through here so close() can wait for whatever is in flight.
  const chain = (fn) => { const p = pending.then(fn, fn); pending = p.catch(() => {}); return p; };

  async function closePort() {
    if (!opened) return;
    opened = false;
    try { await port.close(); } catch (e) { say('close: ' + detail(e)); }
  }

  async function shutdown() {
    if (client) {
      const c = client;
      client = null;
      try { await c.close(); } catch (e) { say('close: ' + detail(e)); }
      // A command the device never answered sits in the client's queue until its own 30 s
      // timer rejects it, and that rejection is unhandled by the client's `initialize()`.
      // Settling it as answered clears the timer without a rejection. The vendored bytes are
      // pinned, so this private name is as stable as the public ones.
      c._rpcFeedback?.resolve([]);
    }
    await closePort();
  }

  const session = {
    get closed() { return closed; },
    /**
     * Opens the port and asks the device whether it speaks Improv. Resolves with `offered: false`
     * whenever it does not, for any reason, and never rejects.
     */
    probe(timeoutMs = PROBE_MS) {
      return chain(async () => {
        if (closed) return { offered: false };
        try {
          await port.open({ baudRate });
          opened = true;
        } catch (e) {
          say('port could not be reopened (' + detail(e) + '); Wi-Fi setup not offered');
          return { offered: false };
        }
        let mod;
        try {
          mod = await loadClient();
          client = new mod.ImprovSerial(port, logger);
        } catch (e) {
          say('client not available (' + detail(e) + '); Wi-Fi setup not offered');
          await closePort();
          return { offered: false };
        }
        try {
          await client.initialize(timeoutMs);
        } catch (e) {
          say('this system does not offer Wi-Fi setup here (' + detail(e) + ')');
          await shutdown();
          return { offered: false };
        }
        const info = client.info ?? {};
        const provisioned = client.state === 4; // ImprovSerialCurrentState.PROVISIONED
        say(`offered by ${info.firmware ?? '?'} ${info.version ?? ''} on ${info.chipFamily ?? '?'}` + (provisioned ? '; already on a network' : ''));
        return { offered: true, provisioned, nextUrl: safeNextUrl(client.nextUrl), info };
      });
    },
    /** Networks the device can see, sorted by the client. An empty list when it cannot scan. */
    scan() {
      return chain(async () => {
        if (!client) return [];
        try {
          return await client.scan();
        } catch (e) {
          say('scan not available (' + detail(e) + ')');
          return [];
        }
      });
    },
    /** Hands the credentials over. Resolves with the device's next URL ('' when it gives none). */
    provision(ssid, password, timeoutMs = PROVISION_MS) {
      return chain(async () => {
        if (!client) throw new InstallError('improv.timeout');
        try {
          await client.provision(String(ssid), String(password ?? ''), timeoutMs);
        } catch (e) {
          const err = mapImprovError(e);
          say('provision failed: ' + err.code + (err.params?.detail ? ' (' + err.params.detail + ')' : ''));
          throw err;
        }
        say('device is on the network');
        return safeNextUrl(client.nextUrl);
      });
    },
    /** Releases the port. Safe to call at any time, any number of times. */
    close() {
      closed = true;
      return chain(shutdown);
    },
  };
  return session;
}
