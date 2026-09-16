/**
 * Stand-in for a Web Serial `SerialPort`: `open()` hands out a readable and a writable stream,
 * `close()` refuses while either is locked, exactly as the browser does. Bytes the page writes
 * go to `onWrite(bytes, port)`; a test (or the fake Improv device) answers with `port.emit()`.
 */
export function makeFakePort({ onWrite } = {}) {
  let controller = null;
  const port = {
    readable: null,
    writable: null,
    opened: [],       // every baud rate passed to open(), in order
    closes: 0,
    cancelled: 0,     // how many times the page cancelled the reader
    written: [],      // every chunk the page wrote, as Uint8Array
    async open(options) {
      if (port.readable) throw new DOMException('The port is already open.', 'InvalidStateError');
      port.opened.push(options?.baudRate);
      port.readable = new ReadableStream({
        start(c) { controller = c; },
        cancel() { port.cancelled += 1; controller = null; },
      });
      port.writable = new WritableStream({
        async write(chunk) {
          const bytes = new Uint8Array(chunk);
          port.written.push(bytes);
          await onWrite?.(bytes, port);
        },
      });
    },
    async close() {
      if (!port.readable) throw new DOMException('The port is already closed.', 'InvalidStateError');
      if (port.readable.locked || port.writable.locked) throw new DOMException('The port is locked.', 'InvalidStateError');
      port.closes += 1;
      controller = null;
      port.readable = null;
      port.writable = null;
    },
    /** Device → page. Accepts a string, an array of bytes or a Uint8Array. */
    emit(data) {
      if (!controller) return false;
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : Uint8Array.from(data);
      controller.enqueue(bytes);
      return true;
    },
    /** The device went away: the readable ends. */
    end() { controller?.close(); controller = null; },
    getInfo() { return {}; },
  };
  return port;
}
