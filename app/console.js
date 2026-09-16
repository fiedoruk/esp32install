/**
 * Serial console: what the device prints after it restarts. Its own read loop at 115200, no
 * esptool-js involved. Bytes are decoded as UTF-8 across chunk boundaries and handed out as
 * complete lines; `stop()` cancels the reader, releases the lock and closes the port, in that
 * order, however it ends. Nothing here writes to the device.
 */
const BAUD = 115200;
export const MAX_LINE = 4096;   // a device that never sends a newline still gets flushed
export const MAX_LINES = 500;   // the page keeps this many lines, whatever the device does

/** Terminal escape sequences and control characters are stripped; tabs survive. */
export function cleanLine(raw) {
  return String(raw)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')   // CSI sequences: colours, cursor moves
    .replace(/\x1b[@-Z\\-_]/g, '')              // two-byte escapes
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')  // the rest of C0, DEL; \t stays
    .replace(/\r$/, '');
}

/** Turns decoded text chunks into complete lines. A line longer than `maxLine` is cut there. */
export function createLineSplitter(onLine, { maxLine = MAX_LINE } = {}) {
  let rest = '';
  const emit = (line) => { try { onLine(cleanLine(line)); } catch { /* a listener never stops the stream */ } };
  return {
    push(text) {
      rest += text;
      let nl;
      while ((nl = rest.indexOf('\n')) !== -1) {
        emit(rest.slice(0, nl));
        rest = rest.slice(nl + 1);
      }
      while (rest.length >= maxLine) {
        emit(rest.slice(0, maxLine));
        rest = rest.slice(maxLine);
      }
    },
    /** Hands out whatever is left without a newline, if anything. */
    flush() {
      if (rest) { emit(rest); rest = ''; }
    },
  };
}

/** A bounded list of lines: pushing past `max` drops the oldest. `text()` is what a <pre> shows. */
export function createLineBuffer(max = MAX_LINES) {
  const lines = [];
  return {
    push(line) {
      lines.push(String(line));
      if (lines.length > max) lines.splice(0, lines.length - max);
    },
    clear() { lines.length = 0; },
    get size() { return lines.length; },
    text() { return lines.length ? lines.join('\n') + '\n' : ''; },
  };
}

/**
 * `createConsole({ port, onLine, onEnd })`: `start()` opens the port if it is closed and reads
 * until `stop()` or until the device goes away; `onEnd(error)` says which. Both are idempotent.
 */
export function createConsole({ port, onLine, onEnd = () => {}, baudRate = BAUD }) {
  let reader = null, loop = null, opened = false, stopping = false;
  const splitter = createLineSplitter(onLine);

  async function readAll() {
    const decoder = new TextDecoder('utf-8');
    let error;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value?.length) splitter.push(decoder.decode(value, { stream: true }));
      }
      splitter.push(decoder.decode()); // the last bytes of a multi-byte character
    } catch (e) {
      if (!stopping) error = e;
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
      reader = null;
    }
    splitter.flush();
    return error;
  }

  return {
    get running() { return reader !== null; },
    async start() {
      if (reader) return;
      stopping = false;
      if (!port.readable) {
        await port.open({ baudRate });
        opened = true;
      }
      reader = port.readable.getReader();
      loop = readAll().then(async (error) => {
        // The device went away or the read failed: release the port so a retry can reopen it.
        if (!stopping) {
          if (opened) { opened = false; try { await port.close(); } catch { /* already gone */ } }
          try { onEnd(error); } catch { /* never ours to fix */ }
        }
        return error;
      });
    },
    async stop() {
      if (!reader && !opened) return;
      stopping = true;
      if (reader) {
        try { await reader.cancel(); } catch { /* the stream may be gone already */ }
        await loop;
      }
      if (opened) {
        opened = false;
        try { await port.close(); } catch { /* already closed */ }
      }
      stopping = false;
    },
  };
}
