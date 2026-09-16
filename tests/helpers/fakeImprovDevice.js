/**
 * A device that speaks Improv Wi-Fi Serial, attached to a fake port. Packets are built from the
 * vendored `const.js`, so the header, the message types and the checksum rule are the library's
 * own bytes, not a second reading of the specification.
 *
 * Scenario knobs: `answers` (a silent device never sends a byte), `provisioned` (already on a
 * network, reports its URL on the first state request), `networks` (what a scan returns; `null`
 * means the device does not know the scan command), `join(ssid, password)` decides what a
 * provision attempt gets back: `'ok'`, `'wifi'` (cannot connect), `'rejected'` or `'silent'`.
 */
import { makeFakePort } from './fakeSerialPort.js';
import { SERIAL_PACKET_HEADER, ImprovSerialMessageType, ImprovSerialCurrentState } from '../../vendor/improv-wifi/const.js';

const RPC = { SEND_WIFI_SETTINGS: 1, REQUEST_CURRENT_STATE: 2, REQUEST_INFO: 3, REQUEST_WIFI_NETWORKS: 4 };
const ERR = { INVALID_RPC_PACKET: 0x01, UNKNOWN_RPC_COMMAND: 0x02, UNABLE_TO_CONNECT: 0x03 };

/** Header, type, length, data, checksum over everything before it, newline. */
export function packet(type, data) {
  const p = [...SERIAL_PACKET_HEADER, type, data.length, ...data, 0, 10];
  p[p.length - 2] = p.slice(0, -2).reduce((sum, b) => sum + b, 0) & 0xff;
  return Uint8Array.from(p);
}

/** An RPC result: the command it answers, then length-prefixed UTF-8 strings. */
export function rpcResult(command, strings) {
  const enc = new TextEncoder();
  const body = strings.flatMap((s) => { const b = [...enc.encode(s)]; return [b.length, ...b]; });
  return packet(ImprovSerialMessageType.RPC_RESULT, [command, body.length, ...body]);
}

const stateOf = (state) => packet(ImprovSerialMessageType.CURRENT_STATE, [state]);
const errorOf = (code) => packet(ImprovSerialMessageType.ERROR_STATE, [code]);

/** Splits what the page wrote into Improv packets and returns `{ command, args }` for each RPC. */
function parseRpc(bytes) {
  const out = [];
  let i = 0;
  while (i + 9 <= bytes.length) {
    const head = String.fromCharCode(...bytes.subarray(i, i + 6));
    if (head !== 'IMPROV') { i += 1; continue; }
    const type = bytes[i + 7], len = bytes[i + 8];
    const data = bytes.subarray(i + 9, i + 9 + len);
    if (type === ImprovSerialMessageType.RPC) out.push({ command: data[0], args: [...data.subarray(2, 2 + data[1])] });
    i += 9 + len + 1;
  }
  return out;
}

export function makeFakeImprovDevice({
  answers = true,
  provisioned = false,
  networks = [{ name: 'Home', rssi: -55, secured: true }, { name: 'Cafe', rssi: -70, secured: false }],
  nextUrl = 'http://192.168.1.23/',
  join = () => 'ok',
  info = ['Demo firmware', '1.0.0', 'ESP32', 'demo-device'],
} = {}) {
  const seen = [];        // every RPC the page sent, as { command, args }
  const attempts = [];    // every provision attempt, as { ssid, password }
  let state = provisioned ? ImprovSerialCurrentState.PROVISIONED : ImprovSerialCurrentState.READY;
  const port = makeFakePort({
    onWrite(bytes) {
      for (const rpc of parseRpc(bytes)) {
        seen.push(rpc);
        if (!answers) continue;
        if (rpc.command === RPC.REQUEST_CURRENT_STATE) {
          port.emit(stateOf(state));
          if (state === ImprovSerialCurrentState.PROVISIONED) port.emit(rpcResult(rpc.command, [nextUrl]));
        } else if (rpc.command === RPC.REQUEST_INFO) {
          port.emit(rpcResult(rpc.command, info));
        } else if (rpc.command === RPC.REQUEST_WIFI_NETWORKS) {
          if (networks === null) { port.emit(errorOf(ERR.UNKNOWN_RPC_COMMAND)); continue; }
          for (const n of networks) port.emit(rpcResult(rpc.command, [n.name, String(n.rssi), n.secured ? 'YES' : 'NO']));
          port.emit(rpcResult(rpc.command, []));
        } else if (rpc.command === RPC.SEND_WIFI_SETTINGS) {
          const dec = new TextDecoder();
          const a = rpc.args;
          const ssid = dec.decode(Uint8Array.from(a.slice(1, 1 + a[0])));
          const password = dec.decode(Uint8Array.from(a.slice(2 + a[0], 2 + a[0] + a[1 + a[0]])));
          attempts.push({ ssid, password });
          const verdict = join(ssid, password);
          if (verdict === 'ok') {
            state = ImprovSerialCurrentState.PROVISIONED;
            port.emit(stateOf(ImprovSerialCurrentState.PROVISIONING));
            port.emit(stateOf(state));
            port.emit(rpcResult(rpc.command, nextUrl ? [nextUrl] : []));
          } else if (verdict !== 'silent') {
            port.emit(errorOf(verdict === 'wifi' ? ERR.UNABLE_TO_CONNECT : ERR.INVALID_RPC_PACKET));
          }
        }
      }
    },
  });
  return { port, seen, attempts, get state() { return state; } };
}
