import { toHex } from "./to-hex.js";
export const hexFormatter = (bytes) => "[" + bytes.map((value) => toHex(value)).join(", ") + "]";
