// Tiny stack VM: make.fun tiny-stack-vm-01 ISA. One run answers i001..i040:
// <input>/<id>/program.bin + input.bin -> <output>/<id>/stdout.bin + exit.txt.
// Node built-ins only, no network, deterministic. In the sandbox /input and
// /output are mounted; the process driver passes them as env vars instead.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const IN = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const OUT = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
const OUT_MAX = 65536, STEP_MAX = 1000000, MIN = -2147483648;

// [opcode, immediate bytes, pops, pushes] for every opcode of the ISA.
const OPS = [
  [0x00, 0, 0, 0], [0x01, 1, 0, 1], [0x02, 4, 0, 1], [0x03, 0, 1, 0],
  [0x04, 0, 1, 2], [0x05, 0, 2, 2], [0x06, 0, 2, 3], [0x07, 0, 3, 3],
  [0x10, 0, 2, 1], [0x11, 0, 2, 1], [0x12, 0, 2, 1], [0x13, 0, 2, 1],
  [0x14, 0, 2, 1], [0x15, 0, 2, 1], [0x16, 0, 2, 1], [0x17, 0, 1, 1],
  [0x18, 0, 2, 1], [0x19, 0, 2, 1], [0x1a, 0, 2, 1], [0x1b, 0, 1, 1],
  [0x1c, 0, 2, 1], [0x1d, 0, 2, 1], [0x1e, 0, 2, 1], [0x20, 0, 2, 1],
  [0x21, 0, 2, 1], [0x22, 0, 2, 1], [0x30, 2, 0, 0], [0x31, 2, 1, 0],
  [0x32, 2, 1, 0], [0x33, 2, 0, 0], [0x34, 0, 0, 0], [0x40, 0, 1, 1],
  [0x41, 0, 2, 0], [0x50, 0, 1, 0], [0x51, 0, 1, 0], [0x52, 0, 0, 1],
  [0x53, 0, 1, 0],
];
const IMM = new Int8Array(256), POPS = new Int8Array(256);
const PUSH = new Int8Array(256), KNOWN = new Uint8Array(256);
for (const [o, i, p, g] of OPS) { IMM[o] = i; POPS[o] = p; PUSH[o] = g; KNOWN[o] = 1; }

// Runs one program on its input. Returns [bytes written, exit code].
function run(prog, input) {
  const n = prog.length;
  const st = new Int32Array(256);
  let sp = 0;
  const cs = new Int32Array(64);
  let cp = 0;
  const mem = new Int32Array(256);
  const out = new Uint8Array(OUT_MAX);
  let ol = 0, ip = 0, pc = 0, steps = 0;
  const done = (c) => [out.slice(0, ol), c];
  for (;;) {
    if (steps === STEP_MAX) return done(10); // step limit
    if (pc < 0 || pc >= n) return done(9); // pc outside the program
    const op = prog[pc];
    if (!KNOWN[op]) return done(5); // unknown opcode
    const imm = IMM[op];
    if (pc + imm >= n) return done(9); // immediate cut off by program end
    steps++;
    const nx = pc + 1 + imm; // address of the next instruction
    if (sp < POPS[op]) return done(2); // stack underflow
    if (sp - POPS[op] + PUSH[op] > 256) return done(3); // stack overflow
    pc = nx;
    switch (op) {
      case 0x00: return done(0); // HALT
      case 0x01: st[sp++] = (prog[nx - 1] << 24) >> 24; break; // PUSH8, sign-extended
      case 0x02: // PUSH32, little-endian signed
        st[sp++] = prog[nx - 4] | (prog[nx - 3] << 8) | (prog[nx - 2] << 16) | (prog[nx - 1] << 24);
        break;
      case 0x03: sp--; break; // POP
      case 0x04: st[sp] = st[sp - 1]; sp++; break; // DUP
      case 0x05: { const t = st[sp - 1]; st[sp - 1] = st[sp - 2]; st[sp - 2] = t; break; } // SWAP
      case 0x06: st[sp] = st[sp - 2]; sp++; break; // OVER
      case 0x07: { // ROT: (a b c -- b c a)
        const a = st[sp - 3];
        st[sp - 3] = st[sp - 2]; st[sp - 2] = st[sp - 1]; st[sp - 1] = a;
        break;
      }
      case 0x17: st[sp - 1] = -st[sp - 1] | 0; break; // NEG, wraps
      case 0x1b: st[sp - 1] = ~st[sp - 1]; break; // NOT
      case 0x30: case 0x31: case 0x32: { // JMP / JZ / JNZ, offset from next instruction
        const rel = ((prog[nx - 2] | (prog[nx - 1] << 8)) << 16) >> 16;
        let take = true;
        if (op !== 0x30) {
          const v = st[--sp];
          take = op === 0x31 ? v === 0 : v !== 0;
        }
        if (take) pc = nx + rel;
        break;
      }
      case 0x33: // CALL: unsigned target, return address is next instruction
        if (cp === 64) return done(7);
        cs[cp++] = nx;
        pc = prog[nx - 2] | (prog[nx - 1] << 8);
        break;
      case 0x34: // RET
        if (cp === 0) return done(8);
        pc = cs[--cp];
        break;
      case 0x40: { // LOAD
        const a = st[sp - 1];
        if (a < 0 || a > 255) return done(6);
        st[sp - 1] = mem[a];
        break;
      }
      case 0x41: { // STORE: (v addr --)
        const a = st[sp - 1], v = st[sp - 2];
        if (a < 0 || a > 255) return done(6);
        sp -= 2; mem[a] = v;
        break;
      }
      case 0x50: { // PRINT: decimal ASCII, no newline
        const s = String(st[sp - 1]);
        if (ol + s.length > OUT_MAX) return done(11);
        sp--;
        for (let i = 0; i < s.length; i++) out[ol++] = s.charCodeAt(i);
        break;
      }
      case 0x51: // PUTC: low byte
        if (ol + 1 > OUT_MAX) return done(11);
        out[ol++] = st[--sp] & 255;
        break;
      case 0x52: st[sp++] = ip < input.length ? input[ip++] : -1; break; // IN: -1 when exhausted
      case 0x53: return done(st[--sp] & 255); // EXIT: low byte
      default: { // two-operand arithmetic / logic / compare
        const b = st[sp - 1], a = st[sp - 2];
        let r;
        switch (op) {
          case 0x10: r = (a + b) | 0; break; // ADD wraps
          case 0x11: r = (a - b) | 0; break; // SUB wraps
          case 0x12: r = Math.imul(a, b); break; // MUL, low 32 bits
          case 0x13: // DIV, truncated toward zero
            if (b === 0) return done(4);
            r = a === MIN && b === -1 ? a : (a / b) | 0;
            break;
          case 0x14: // MOD, sign of the dividend
            if (b === 0) return done(4);
            r = b === -1 ? 0 : (a % b) | 0;
            break;
          case 0x15: // DIVU, unsigned
            if (b === 0) return done(4);
            r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
            break;
          case 0x16: // MODU, unsigned
            if (b === 0) return done(4);
            r = ((a >>> 0) % (b >>> 0)) | 0;
            break;
          case 0x18: r = a & b; break;
          case 0x19: r = a | b; break;
          case 0x1a: r = a ^ b; break;
          case 0x1c: r = a << (b & 31); break; // SHL, count masked to 5 bits
          case 0x1d: r = a >> (b & 31); break; // SHR, arithmetic
          case 0x1e: r = (a >>> (b & 31)) | 0; break; // SHRU, logical
          case 0x20: r = a === b ? 1 : 0; break; // EQ
          case 0x21: r = a < b ? 1 : 0; break; // LT, signed
          default: r = (a >>> 0) < (b >>> 0) ? 1 : 0; // LTU, unsigned
        }
        sp -= 2;
        st[sp++] = r;
      }
    }
  }
}

for (let k = 1; k <= 40; k++) {
  const id = "i" + String(k).padStart(3, "0");
  const [stdout, code] = run(readFileSync(`${IN}/${id}/program.bin`), readFileSync(`${IN}/${id}/input.bin`));
  mkdirSync(`${OUT}/${id}`, { recursive: true });
  writeFileSync(`${OUT}/${id}/stdout.bin`, stdout);
  writeFileSync(`${OUT}/${id}/exit.txt`, String(code) + "\n");
}
