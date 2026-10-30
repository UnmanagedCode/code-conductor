#!/usr/bin/env node
// A stand-in for src/systems/ptyHelper.py that runs no program and never
// reports input written unless told to — so what src/systems/ptyHost.ts sends
// a helper whose program reads nothing can be counted exactly.
//
//   node fakePtyHelper.mjs <record> <grant> [the helper's own arguments, ignored]
//
// Answers the `v` frame with `S`. Counts `d` payload bytes. Each `r` frame is a
// BARRIER: the helper's stdin is ordered, so every `d` ptyHost sent before the
// `r` has been counted when it arrives. On each one it appends `R <total>` to
// <record>; on the FIRST it then reports <grant> bytes written (`w`), and
// nothing more ever. Exits at stdin EOF.

import { appendFileSync } from 'node:fs';

const record = process.argv[2];
const grant = Number(process.argv[3]);
const frame = (type, payload = Buffer.alloc(0)) => {
  const head = Buffer.alloc(5);
  head.write(type, 0, 1, 'latin1');
  head.writeUInt32BE(payload.length, 1);
  process.stdout.write(Buffer.concat([head, payload]));
};

let buf = Buffer.alloc(0);
let total = 0;
let barriers = 0;
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 5) {
    const len = buf.readUInt32BE(1);
    if (buf.length < 5 + len) break;
    const type = buf.toString('latin1', 0, 1);
    buf = buf.subarray(5 + len);
    if (type === 'v') frame('S');
    else if (type === 'd') total += len;
    else if (type === 'r') {
      appendFileSync(record, `R ${total}\n`);
      if (barriers++ === 0) {
        const n = Buffer.alloc(4);
        n.writeUInt32BE(grant, 0);
        frame('w', n);
      }
    }
  }
});
process.stdin.on('end', () => process.exit(0));
