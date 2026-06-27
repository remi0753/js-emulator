// Soft-float runtime helpers for the chibicc custom32 backend.
//
// The compiler passes raw IEEE-754 bits through the integer ABI: binary32 in
// R0/one stack slot, binary64 in R0:R1/two stack slots. This runtime is written
// without C float/double so it can be compiled by the same frontend. The
// binary32 path implements normal finite arithmetic with basic IEEE special
// values; the binary64 path currently reuses the binary32 core via
// truncate/extend helpers, preserving the ABI while keeping the Phase 32 slice
// small enough to audit.

import type { ObjectFile } from '../../formats/object.ts';
import { compileObject } from './index.ts';

export const FLOAT_RUNTIME_SOURCE = `
unsigned __sf_abs(unsigned x) { return x & 2147483647u; }
unsigned __sf_sign(unsigned x) { return x >> 31; }
unsigned __sf_exp(unsigned x) { return (x >> 23) & 255u; }
unsigned __sf_frac(unsigned x) { return x & 8388607u; }

unsigned __sf_pack(unsigned sign, int exp, unsigned mant) {
  if (mant == 0) return sign << 31;
  while (mant >= 16777216u) { mant = mant >> 1; exp = exp + 1; }
  while (mant < 8388608u && exp > -126) { mant = mant << 1; exp = exp - 1; }
  if (exp > 127) return (sign << 31) | 2139095040u;
  if (exp < -126) return sign << 31;
  return (sign << 31) | ((exp + 127) << 23) | (mant & 8388607u);
}

int __sf_unpack(unsigned a, unsigned *sign, int *exp, unsigned *mant) {
  unsigned e = __sf_exp(a);
  *sign = __sf_sign(a);
  if (e == 255u) return 0;
  if (e == 0u) {
    *exp = -126;
    *mant = __sf_frac(a);
    return *mant != 0u;
  }
  *exp = (int)e - 127;
  *mant = __sf_frac(a) | 8388608u;
  return 1;
}

unsigned __addsf3(unsigned a, unsigned b) {
  if (__sf_abs(a) == 0u) return b;
  if (__sf_abs(b) == 0u) return a;
  if (__sf_exp(a) == 255u) return a;
  if (__sf_exp(b) == 255u) return b;

  unsigned as; unsigned bs; int ae; int be; unsigned am; unsigned bm;
  __sf_unpack(a, &as, &ae, &am);
  __sf_unpack(b, &bs, &be, &bm);
  if (ae < be) {
    unsigned ts = as; as = bs; bs = ts;
    int te = ae; ae = be; be = te;
    unsigned tm = am; am = bm; bm = tm;
  }
  int diff = ae - be;
  if (diff > 31) bm = 0u;
  else bm = bm >> diff;

  unsigned sign = as;
  unsigned mant;
  if (as == bs) {
    mant = am + bm;
  } else if (am >= bm) {
    mant = am - bm;
  } else {
    mant = bm - am;
    sign = bs;
  }
  return __sf_pack(sign, ae, mant);
}

unsigned __subsf3(unsigned a, unsigned b) {
  return __addsf3(a, b ^ 2147483648u);
}

unsigned __mulsf3(unsigned a, unsigned b) {
  if (__sf_abs(a) == 0u || __sf_abs(b) == 0u) return (__sf_sign(a) ^ __sf_sign(b)) << 31;
  if (__sf_exp(a) == 255u) return (__sf_sign(a) ^ __sf_sign(b)) << 31 | 2139095040u;
  if (__sf_exp(b) == 255u) return (__sf_sign(a) ^ __sf_sign(b)) << 31 | 2139095040u;
  unsigned as; unsigned bs; int ae; int be; unsigned am; unsigned bm;
  __sf_unpack(a, &as, &ae, &am);
  __sf_unpack(b, &bs, &be, &bm);
  unsigned long long prod = (unsigned long long)am * (unsigned long long)bm;
  int exp = ae + be;
  unsigned mant;
  if ((prod >> 47) != 0ull) {
    mant = prod >> 24;
    exp = exp + 1;
  } else {
    mant = prod >> 23;
  }
  return __sf_pack(as ^ bs, exp, mant);
}

unsigned __divsf3(unsigned a, unsigned b) {
  unsigned sign = __sf_sign(a) ^ __sf_sign(b);
  if (__sf_abs(b) == 0u) return (sign << 31) | 2139095040u;
  if (__sf_abs(a) == 0u) return sign << 31;
  if (__sf_exp(a) == 255u) return (sign << 31) | 2139095040u;
  if (__sf_exp(b) == 255u) return sign << 31;
  unsigned as; unsigned bs; int ae; int be; unsigned am; unsigned bm;
  __sf_unpack(a, &as, &ae, &am);
  __sf_unpack(b, &bs, &be, &bm);
  unsigned long long num = (unsigned long long)am << 23;
  unsigned mant = num / bm;
  return __sf_pack(sign, ae - be, mant);
}

int __cmpsf2(unsigned a, unsigned b) {
  unsigned aa = __sf_abs(a);
  unsigned bb = __sf_abs(b);
  if (aa == 0u && bb == 0u) return 0;
  unsigned as = __sf_sign(a);
  unsigned bs = __sf_sign(b);
  if (as != bs) {
    if (as) return -1;
    return 1;
  }
  if (a == b) return 0;
  if (as) {
    if (aa > bb) return -1;
    return 1;
  }
  if (aa < bb) return -1;
  return 1;
}

unsigned __floatsisf(int v) {
  if (v == 0) return 0u;
  unsigned sign = 0u;
  unsigned x;
  if (v < 0) { sign = 1u; x = (unsigned)(0 - v); }
  else x = v;
  int msb = 31;
  while (((x >> msb) & 1u) == 0u) msb = msb - 1;
  unsigned mant;
  if (msb > 23) mant = x >> (msb - 23);
  else mant = x << (23 - msb);
  return __sf_pack(sign, msb, mant);
}

unsigned __floatunsisf(unsigned x) {
  if (x == 0u) return 0u;
  int msb = 31;
  while (((x >> msb) & 1u) == 0u) msb = msb - 1;
  unsigned mant;
  if (msb > 23) mant = x >> (msb - 23);
  else mant = x << (23 - msb);
  return __sf_pack(0u, msb, mant);
}

int __fixsfsi(unsigned f) {
  unsigned sign; int exp; unsigned mant;
  if (!__sf_unpack(f, &sign, &exp, &mant)) return 0;
  if (exp < 0) return 0;
  unsigned v;
  if (exp > 23) v = mant << (exp - 23);
  else v = mant >> (23 - exp);
  if (sign) return 0 - (int)v;
  return (int)v;
}

unsigned long long __extendsfdf2(unsigned f) {
  unsigned sign = __sf_sign(f);
  unsigned e = __sf_exp(f);
  unsigned frac = __sf_frac(f);
  if (e == 0u && frac == 0u) return (unsigned long long)sign << 63;
  if (e == 255u) return ((unsigned long long)sign << 63) | 9218868437227405312ull | ((unsigned long long)frac << 29);
  unsigned long long de = (unsigned long long)((int)e - 127 + 1023);
  return ((unsigned long long)sign << 63) | (de << 52) | ((unsigned long long)frac << 29);
}

unsigned __truncdfsf2(unsigned lo, unsigned hi) {
  unsigned sign = hi >> 31;
  unsigned e = (hi >> 20) & 2047u;
  unsigned hfrac = hi & 1048575u;
  if (e == 0u && hfrac == 0u && lo == 0u) return sign << 31;
  if (e == 2047u) return (sign << 31) | 2139095040u | (hfrac >> 9);
  int se = (int)e - 1023 + 127;
  if (se <= 0) return sign << 31;
  if (se >= 255) return (sign << 31) | 2139095040u;
  unsigned frac = (hfrac << 3) | (lo >> 29);
  return (sign << 31) | ((unsigned)se << 23) | (frac & 8388607u);
}

unsigned long long __adddf3(unsigned alo, unsigned ahi, unsigned blo, unsigned bhi) {
  return __extendsfdf2(__addsf3(__truncdfsf2(alo, ahi), __truncdfsf2(blo, bhi)));
}

unsigned long long __subdf3(unsigned alo, unsigned ahi, unsigned blo, unsigned bhi) {
  return __extendsfdf2(__subsf3(__truncdfsf2(alo, ahi), __truncdfsf2(blo, bhi)));
}

unsigned long long __muldf3(unsigned alo, unsigned ahi, unsigned blo, unsigned bhi) {
  return __extendsfdf2(__mulsf3(__truncdfsf2(alo, ahi), __truncdfsf2(blo, bhi)));
}

unsigned long long __divdf3(unsigned alo, unsigned ahi, unsigned blo, unsigned bhi) {
  return __extendsfdf2(__divsf3(__truncdfsf2(alo, ahi), __truncdfsf2(blo, bhi)));
}

int __cmpdf2(unsigned alo, unsigned ahi, unsigned blo, unsigned bhi) {
  return __cmpsf2(__truncdfsf2(alo, ahi), __truncdfsf2(blo, bhi));
}

unsigned long long __floatsidf(int v) { return __extendsfdf2(__floatsisf(v)); }
unsigned long long __floatunsidf(unsigned v) { return __extendsfdf2(__floatunsisf(v)); }
int __fixdfsi(unsigned lo, unsigned hi) { return __fixsfsi(__truncdfsf2(lo, hi)); }
`;

export function floatRuntimeObject(): ObjectFile {
  return compileObject(FLOAT_RUNTIME_SOURCE, { name: 'float.o' });
}
