// 64-bit (`long long`) runtime helpers for the chibicc custom32 backend.
//
// A 64-bit value is two 32-bit words (low, high). The backend (codegen.ts)
// lowers `long long` arithmetic, shifts, comparisons, and negation to calls to
// these helpers. Each arithmetic/shift/unary helper writes its 8-byte result
// through a pointer into a caller-reserved temporary, so the helpers themselves
// use only 32-bit operations and need no `long long` support to compile — they
// are ordinary C compiled by the same chibicc frontend and linked in.
//
// The compare helpers return a signed -1/0/1 in the normal 32-bit return
// register. Names follow the reserved `__i64_*` / `__u64_*` families in
// docs/custom32-c-abi.md.

import type { ObjectFile } from '../../formats/object.ts';
import { compileObject } from './index.ts';

export const I64_RUNTIME_SOURCE = `
/* res = a + b (carry-propagating) */
void __i64_add(unsigned *r, unsigned alo, unsigned ahi, unsigned blo, unsigned bhi) {
  unsigned lo = alo + blo;
  unsigned carry = 0;
  if (lo < alo) carry = 1;
  r[0] = lo;
  r[1] = ahi + bhi + carry;
}

/* res = a - b (borrow-propagating) */
void __i64_sub(unsigned *r, unsigned alo, unsigned ahi, unsigned blo, unsigned bhi) {
  unsigned borrow = 0;
  if (alo < blo) borrow = 1;
  r[0] = alo - blo;
  r[1] = ahi - bhi - borrow;
}

/* res = a * b (low 64 bits), via 16x16 partial products for the low word's
   carry into the high word */
void __i64_mul(unsigned *r, unsigned alo, unsigned ahi, unsigned blo, unsigned bhi) {
  unsigned a0 = alo & 65535;
  unsigned a1 = alo >> 16;
  unsigned b0 = blo & 65535;
  unsigned b1 = blo >> 16;
  unsigned t00 = a0 * b0;
  unsigned t01 = a0 * b1;
  unsigned t10 = a1 * b0;
  unsigned t11 = a1 * b1;
  unsigned mid = (t00 >> 16) + (t01 & 65535) + (t10 & 65535);
  r[0] = (t00 & 65535) | (mid << 16);
  r[1] = t11 + (t01 >> 16) + (t10 >> 16) + (mid >> 16) + alo * bhi + ahi * blo;
}

void __i64_and(unsigned *r, unsigned alo, unsigned ahi, unsigned blo, unsigned bhi) {
  r[0] = alo & blo;
  r[1] = ahi & bhi;
}

void __i64_or(unsigned *r, unsigned alo, unsigned ahi, unsigned blo, unsigned bhi) {
  r[0] = alo | blo;
  r[1] = ahi | bhi;
}

void __i64_xor(unsigned *r, unsigned alo, unsigned ahi, unsigned blo, unsigned bhi) {
  r[0] = alo ^ blo;
  r[1] = ahi ^ bhi;
}

/* res = -v (two's complement) */
void __i64_neg(unsigned *r, unsigned lo, unsigned hi) {
  unsigned nlo = ~lo + 1;
  unsigned carry = 0;
  if (nlo == 0) carry = 1;
  r[0] = nlo;
  r[1] = ~hi + carry;
}

void __i64_shl(unsigned *r, unsigned lo, unsigned hi, int amt) {
  amt = amt & 63;
  if (amt == 0) { r[0] = lo; r[1] = hi; return; }
  if (amt >= 32) { r[0] = 0; r[1] = lo << (amt - 32); return; }
  r[0] = lo << amt;
  r[1] = (hi << amt) | (lo >> (32 - amt));
}

/* logical (unsigned) right shift */
void __i64_shr(unsigned *r, unsigned lo, unsigned hi, int amt) {
  amt = amt & 63;
  if (amt == 0) { r[0] = lo; r[1] = hi; return; }
  if (amt >= 32) { r[0] = hi >> (amt - 32); r[1] = 0; return; }
  r[0] = (lo >> amt) | (hi << (32 - amt));
  r[1] = hi >> amt;
}

/* arithmetic (signed) right shift */
void __i64_sar(unsigned *r, unsigned lo, unsigned hi, int amt) {
  int shi = hi;
  unsigned fill = 0;
  if (hi >> 31) fill = 4294967295u;
  amt = amt & 63;
  if (amt == 0) { r[0] = lo; r[1] = hi; return; }
  if (amt >= 32) { r[0] = shi >> (amt - 32); r[1] = fill; return; }
  r[0] = (lo >> amt) | (hi << (32 - amt));
  r[1] = shi >> amt;
}

/* unsigned 64-bit divmod: q = a / b, rem = a % b, via shift-subtract */
void __u64_divmod(unsigned alo, unsigned ahi, unsigned blo, unsigned bhi,
                  unsigned *qlo, unsigned *qhi, unsigned *rlo, unsigned *rhi) {
  unsigned ql = 0;
  unsigned qh = 0;
  unsigned rl = 0;
  unsigned rh = 0;
  int i = 63;
  while (i >= 0) {
    rh = (rh << 1) | (rl >> 31);
    rl = rl << 1;
    unsigned bit;
    if (i >= 32) bit = (ahi >> (i - 32)) & 1;
    else bit = (alo >> i) & 1;
    rl = rl | bit;
    if (rh > bhi || (rh == bhi && rl >= blo)) {
      unsigned borrow = 0;
      if (rl < blo) borrow = 1;
      rl = rl - blo;
      rh = rh - bhi - borrow;
      if (i >= 32) qh = qh | (1 << (i - 32));
      else ql = ql | (1 << i);
    }
    i = i - 1;
  }
  qlo[0] = ql;
  qhi[0] = qh;
  rlo[0] = rl;
  rhi[0] = rh;
}

void __u64_div(unsigned *r, unsigned alo, unsigned ahi, unsigned blo, unsigned bhi) {
  unsigned ql; unsigned qh; unsigned rl; unsigned rh;
  __u64_divmod(alo, ahi, blo, bhi, &ql, &qh, &rl, &rh);
  r[0] = ql;
  r[1] = qh;
}

void __u64_mod(unsigned *r, unsigned alo, unsigned ahi, unsigned blo, unsigned bhi) {
  unsigned ql; unsigned qh; unsigned rl; unsigned rh;
  __u64_divmod(alo, ahi, blo, bhi, &ql, &qh, &rl, &rh);
  r[0] = rl;
  r[1] = rh;
}

void __i64_div(unsigned *r, unsigned alo, unsigned ahi, unsigned blo, unsigned bhi) {
  int aneg = (ahi >> 31) & 1;
  int bneg = (bhi >> 31) & 1;
  if (aneg) { unsigned c = 0; if (alo == 0) c = 1; alo = ~alo + 1; ahi = ~ahi + c; }
  if (bneg) { unsigned c = 0; if (blo == 0) c = 1; blo = ~blo + 1; bhi = ~bhi + c; }
  unsigned ql; unsigned qh; unsigned rl; unsigned rh;
  __u64_divmod(alo, ahi, blo, bhi, &ql, &qh, &rl, &rh);
  if (aneg ^ bneg) { unsigned c = 0; if (ql == 0) c = 1; ql = ~ql + 1; qh = ~qh + c; }
  r[0] = ql;
  r[1] = qh;
}

void __i64_mod(unsigned *r, unsigned alo, unsigned ahi, unsigned blo, unsigned bhi) {
  int aneg = (ahi >> 31) & 1;
  int bneg = (bhi >> 31) & 1;
  if (aneg) { unsigned c = 0; if (alo == 0) c = 1; alo = ~alo + 1; ahi = ~ahi + c; }
  if (bneg) { unsigned c = 0; if (blo == 0) c = 1; blo = ~blo + 1; bhi = ~bhi + c; }
  unsigned ql; unsigned qh; unsigned rl; unsigned rh;
  __u64_divmod(alo, ahi, blo, bhi, &ql, &qh, &rl, &rh);
  if (aneg) { unsigned c = 0; if (rl == 0) c = 1; rl = ~rl + 1; rh = ~rh + c; }
  r[0] = rl;
  r[1] = rh;
}

/* signed compare: -1 if a < b, 0 if equal, 1 if a > b */
int __i64_cmp(unsigned alo, unsigned ahi, unsigned blo, unsigned bhi) {
  int sa = ahi;
  int sb = bhi;
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  if (alo < blo) return -1;
  if (alo > blo) return 1;
  return 0;
}

/* unsigned compare: -1 if a < b, 0 if equal, 1 if a > b */
int __u64_cmp(unsigned alo, unsigned ahi, unsigned blo, unsigned bhi) {
  if (ahi < bhi) return -1;
  if (ahi > bhi) return 1;
  if (alo < blo) return -1;
  if (alo > blo) return 1;
  return 0;
}
`;

// Compile the 64-bit runtime helpers into a relocatable object to link into any
// program that uses `long long`.
export function i64RuntimeObject(): ObjectFile {
  return compileObject(I64_RUNTIME_SOURCE, { name: 'i64.o' });
}
