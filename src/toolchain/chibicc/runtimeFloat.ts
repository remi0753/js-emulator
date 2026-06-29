// Soft-float runtime helpers for the chibicc custom32 backend.
//
// The compiler passes raw IEEE-754 bits through the integer ABI: binary32 in
// R0/one stack slot, binary64 in R0:R1/two stack slots. This runtime is written
// without C float/double so it can be compiled by the same frontend. The
// binary32 and binary64 paths implement normal finite arithmetic plus basic
// IEEE special values. They keep the default round-to-nearest-even behavior for
// the guard bits that the helpers retain.

import { type Archive, encodeArchive, parseArchive } from '../../formats/archive.ts';
import type { ObjectFile } from '../../formats/object.ts';
import { encodeObject } from '../../formats/object.ts';
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
  if (e == 255u) return ((unsigned long long)sign << 63) | ((unsigned long long)2047u << 52) | ((unsigned long long)frac << 29);
  int exp = (int)e - 127;
  unsigned mant = frac | 8388608u;
  if (e == 0u) {
    exp = -126;
    mant = frac;
    while (mant < 8388608u) { mant = mant << 1; exp = exp - 1; }
    mant = mant & 8388607u;
  }
  unsigned long long de = (unsigned long long)(exp + 1023);
  return ((unsigned long long)sign << 63) | (de << 52) | ((unsigned long long)(mant & 8388607u) << 29);
}

unsigned long long __df_make(unsigned lo, unsigned hi) {
  return ((unsigned long long)hi << 32) | (unsigned long long)lo;
}

unsigned __df_sign(unsigned long long x) { return x >> 63; }
unsigned __df_exp(unsigned long long x) { return (x >> 52) & 2047ull; }
unsigned long long __df_frac(unsigned long long x) { return x & ((1ull << 52) - 1ull); }
unsigned long long __df_qnan(void) { return ((unsigned long long)2047u << 52) | (1ull << 51); }
unsigned long long __df_inf(unsigned sign) {
  return ((unsigned long long)sign << 63) | ((unsigned long long)2047u << 52);
}

int __df_is_nan(unsigned long long x) {
  return __df_exp(x) == 2047u && __df_frac(x) != 0ull;
}

int __df_is_inf(unsigned long long x) {
  return __df_exp(x) == 2047u && __df_frac(x) == 0ull;
}

unsigned long long __df_shift_right_jam(unsigned long long v, int dist) {
  if (dist <= 0) return v;
  if (dist >= 63) {
    if (v != 0ull) return 1ull;
    return 0ull;
  }
  unsigned long long extra = v << (64 - dist);
  v = v >> dist;
  if (extra != 0ull) v = v | 1ull;
  return v;
}

unsigned long long __df_shift_right_jam128(unsigned long long hi, unsigned long long lo, int dist) {
  if (dist <= 0) return lo;
  if (dist < 64) {
    unsigned long long shifted = (lo >> dist) | (hi << (64 - dist));
    unsigned long long mask = (1ull << dist) - 1ull;
    if ((lo & mask) != 0ull) shifted = shifted | 1ull;
    return shifted;
  }
  int hdist = dist - 64;
  if (hdist >= 63) {
    if (hi != 0ull || lo != 0ull) return 1ull;
    return 0ull;
  }
  unsigned long long shifted = hi >> hdist;
  unsigned long long mask = (1ull << hdist) - 1ull;
  if (lo != 0ull || (hi & mask) != 0ull) shifted = shifted | 1ull;
  return shifted;
}

int __df_unpack(unsigned long long x, unsigned *sign, int *exp, unsigned long long *mant) {
  unsigned e = __df_exp(x);
  unsigned long long frac = __df_frac(x);
  *sign = __df_sign(x);
  if (e == 2047u) return 0;
  if (e == 0u) {
    *exp = -1022;
    *mant = frac;
    return frac != 0ull;
  }
  *exp = (int)e - 1023;
  *mant = (1ull << 52) | frac;
  return 1;
}

void __df_normalize(int *exp, unsigned long long *mant) {
  if (*mant == 0ull) return;
  while (*mant < (1ull << 52)) {
    *mant = *mant << 1;
    *exp = *exp - 1;
  }
}

unsigned long long __df_pack(unsigned sign, int exp, unsigned long long mant) {
  unsigned long long top = 1ull << 55;
  unsigned long long hidden = 1ull << 52;
  if (mant == 0ull) return (unsigned long long)sign << 63;
  while (mant >= (top << 1)) {
    unsigned sticky = mant & 1ull;
    mant = mant >> 1;
    if (sticky) mant = mant | 1ull;
    exp = exp + 1;
  }
  while (mant < top && exp > -1022) {
    mant = mant << 1;
    exp = exp - 1;
  }
  if (exp > 1023) return __df_inf(sign);
  if (exp < -1022) {
    mant = __df_shift_right_jam(mant, -1022 - exp);
    exp = -1022;
  }

  unsigned rem = mant & 7ull;
  unsigned long long frac = mant >> 3;
  if (rem > 4u || (rem == 4u && (frac & 1ull) != 0ull)) frac = frac + 1ull;
  if (frac >= (hidden << 1)) {
    frac = frac >> 1;
    exp = exp + 1;
    if (exp > 1023) return __df_inf(sign);
  }

  unsigned expbits;
  if (exp == -1022 && frac < hidden) expbits = 0u;
  else expbits = exp + 1023;
  return ((unsigned long long)sign << 63) | ((unsigned long long)expbits << 52) | (frac & (hidden - 1ull));
}

unsigned long long __df_add_core(unsigned long long a, unsigned long long b) {
  if (__df_is_nan(a) || __df_is_nan(b)) return __df_qnan();
  if (__df_is_inf(a) && __df_is_inf(b) && __df_sign(a) != __df_sign(b)) return __df_qnan();
  if (__df_is_inf(a)) return a;
  if (__df_is_inf(b)) return b;
  if ((a << 1) == 0ull && (b << 1) == 0ull) {
    if (__df_sign(a) && __df_sign(b)) return 1ull << 63;
    return 0ull;
  }
  if ((a << 1) == 0ull) return b;
  if ((b << 1) == 0ull) return a;

  unsigned as; unsigned bs; int ae; int be; unsigned long long am; unsigned long long bm;
  __df_unpack(a, &as, &ae, &am);
  __df_unpack(b, &bs, &be, &bm);
  __df_normalize(&ae, &am);
  __df_normalize(&be, &bm);

  if (ae < be || (ae == be && am < bm)) {
    unsigned ts = as; as = bs; bs = ts;
    int te = ae; ae = be; be = te;
    unsigned long long tm = am; am = bm; bm = tm;
  }
  am = am << 3;
  bm = bm << 3;
  bm = __df_shift_right_jam(bm, ae - be);

  unsigned sign = as;
  unsigned long long mant;
  if (as == bs) {
    mant = am + bm;
  } else if (am >= bm) {
    mant = am - bm;
  } else {
    mant = bm - am;
    sign = bs;
  }
  return __df_pack(sign, ae, mant);
}

unsigned long long __adddf3(unsigned alo, unsigned ahi, unsigned blo, unsigned bhi) {
  return __df_add_core(__df_make(alo, ahi), __df_make(blo, bhi));
}

unsigned long long __subdf3(unsigned alo, unsigned ahi, unsigned blo, unsigned bhi) {
  return __df_add_core(__df_make(alo, ahi), __df_make(blo, bhi) ^ (1ull << 63));
}

void __u128_add(unsigned long long *hi, unsigned long long *lo, unsigned long long ahi, unsigned long long alo) {
  unsigned long long old = *lo;
  *lo = *lo + alo;
  *hi = *hi + ahi;
  if (*lo < old) *hi = *hi + 1ull;
}

unsigned long long __muldf3(unsigned alo, unsigned ahi, unsigned blo, unsigned bhi) {
  unsigned long long a = __df_make(alo, ahi);
  unsigned long long b = __df_make(blo, bhi);
  unsigned sign = __df_sign(a) ^ __df_sign(b);
  if (__df_is_nan(a) || __df_is_nan(b)) return __df_qnan();
  if ((__df_is_inf(a) && (b << 1) == 0ull) || (__df_is_inf(b) && (a << 1) == 0ull)) return __df_qnan();
  if (__df_is_inf(a) || __df_is_inf(b)) return __df_inf(sign);
  if ((a << 1) == 0ull || (b << 1) == 0ull) return (unsigned long long)sign << 63;

  unsigned as; unsigned bs; int ae; int be; unsigned long long am; unsigned long long bm;
  __df_unpack(a, &as, &ae, &am);
  __df_unpack(b, &bs, &be, &bm);
  __df_normalize(&ae, &am);
  __df_normalize(&be, &bm);

  unsigned long long hi = 0ull;
  unsigned long long lo = 0ull;
  int i = 0;
  while (i < 53) {
    if (((bm >> i) & 1ull) != 0ull) {
      unsigned long long alo2;
      unsigned long long ahi2;
      if (i == 0) {
        alo2 = am;
        ahi2 = 0ull;
      } else {
        alo2 = am << i;
        ahi2 = am >> (64 - i);
      }
      __u128_add(&hi, &lo, ahi2, alo2);
    }
    i = i + 1;
  }

  int exp = ae + be;
  unsigned long long mant;
  if (((hi >> 41) & 1ull) != 0ull) {
    mant = __df_shift_right_jam128(hi, lo, 50);
    exp = exp + 1;
  } else {
    mant = __df_shift_right_jam128(hi, lo, 49);
  }
  return __df_pack(sign, exp, mant);
}

unsigned long long __divdf3(unsigned alo, unsigned ahi, unsigned blo, unsigned bhi) {
  unsigned long long a = __df_make(alo, ahi);
  unsigned long long b = __df_make(blo, bhi);
  unsigned sign = __df_sign(a) ^ __df_sign(b);
  if (__df_is_nan(a) || __df_is_nan(b)) return __df_qnan();
  if (__df_is_inf(a) && __df_is_inf(b)) return __df_qnan();
  if ((a << 1) == 0ull && (b << 1) == 0ull) return __df_qnan();
  if ((b << 1) == 0ull) return __df_inf(sign);
  if ((a << 1) == 0ull) return (unsigned long long)sign << 63;
  if (__df_is_inf(a)) return __df_inf(sign);
  if (__df_is_inf(b)) return (unsigned long long)sign << 63;

  unsigned as; unsigned bs; int ae; int be; unsigned long long am; unsigned long long bm;
  __df_unpack(a, &as, &ae, &am);
  __df_unpack(b, &bs, &be, &bm);
  __df_normalize(&ae, &am);
  __df_normalize(&be, &bm);

  // Normalize the dividend into [bm, 2*bm) so the quotient is in [1, 2) and
  // lands as a 56-bit value in [2^55, 2^56) -- exactly what __df_pack expects.
  // Generating 55 fraction bits *below* an explicit integer bit avoids the
  // off-by-one that dropped the quotient's integer bit whenever am >= bm (a
  // plain 55-iteration loop can only ever hold 55 bits, i.e. < 2^55).
  int exp = ae - be;
  unsigned long long rem = am;
  if (am < bm) {
    rem = am << 1;
    exp = exp - 1;
  }
  unsigned long long q = 1ull;
  rem = rem - bm;
  int i = 0;
  while (i < 55) {
    rem = rem << 1;
    q = q << 1;
    if (rem >= bm) {
      rem = rem - bm;
      q = q | 1ull;
    }
    i = i + 1;
  }
  if (rem != 0ull) q = q | 1ull;
  return __df_pack(sign, exp, q);
}

int __cmpdf2(unsigned alo, unsigned ahi, unsigned blo, unsigned bhi) {
  unsigned long long a = __df_make(alo, ahi);
  unsigned long long b = __df_make(blo, bhi);
  if (__df_is_nan(a) || __df_is_nan(b)) return 1;
  if ((a << 1) == 0ull && (b << 1) == 0ull) return 0;
  unsigned as = __df_sign(a);
  unsigned bs = __df_sign(b);
  if (as != bs) {
    if (as) return -1;
    return 1;
  }
  if (a == b) return 0;
  unsigned long long aa = a << 1;
  unsigned long long bb = b << 1;
  if (as) {
    if (aa > bb) return -1;
    return 1;
  }
  if (aa < bb) return -1;
  return 1;
}

unsigned long long __floatsidf(int v) {
  if (v == 0) return 0ull;
  unsigned sign = 0u;
  unsigned x;
  if (v < 0) { sign = 1u; x = 0u - (unsigned)v; }
  else x = v;
  int msb = 31;
  while (((x >> msb) & 1u) == 0u) msb = msb - 1;
  unsigned long long mant = (unsigned long long)x;
  mant = mant << (52 - msb);
  return __df_pack(sign, msb, mant << 3);
}

unsigned long long __floatunsidf(unsigned x) {
  if (x == 0u) return 0ull;
  int msb = 31;
  while (((x >> msb) & 1u) == 0u) msb = msb - 1;
  unsigned long long mant = (unsigned long long)x;
  mant = mant << (52 - msb);
  return __df_pack(0u, msb, mant << 3);
}

int __fixdfsi(unsigned lo, unsigned hi) {
  unsigned long long x = __df_make(lo, hi);
  unsigned sign; int exp; unsigned long long mant;
  if (!__df_unpack(x, &sign, &exp, &mant)) return 0;
  __df_normalize(&exp, &mant);
  if (exp < 0) return 0;
  if (exp > 31) {
    if (sign) return (int)2147483648u;
    return 2147483647;
  }
  unsigned long long v;
  if (exp > 52) v = mant << (exp - 52);
  else v = mant >> (52 - exp);
  if (sign) return 0 - (int)v;
  return (int)v;
}

unsigned __truncdfsf2(unsigned lo, unsigned hi) {
  unsigned long long x = __df_make(lo, hi);
  unsigned sign = __df_sign(x);
  int exp; unsigned long long mant;
  if (__df_is_nan(x)) return 2143289344u;
  if (__df_is_inf(x)) return (sign << 31) | 2139095040u;
  if (!__df_unpack(x, &sign, &exp, &mant)) return sign << 31;
  __df_normalize(&exp, &mant);
  if (exp > 127) return (sign << 31) | 2139095040u;
  if (exp < -149) return sign << 31;
  if (exp < -126) mant = __df_shift_right_jam(mant, -126 - exp);
  unsigned sfmant = mant >> 29;
  return __sf_pack(sign, exp, sfmant);
}
`;

export function floatRuntimeObject(): ObjectFile {
  return compileObject(FLOAT_RUNTIME_SOURCE, { name: 'float.o' });
}

const FLOAT_RUNTIME_PROTOTYPES = `
unsigned __sf_abs(unsigned x);
unsigned __sf_sign(unsigned x);
unsigned __sf_exp(unsigned x);
unsigned __sf_frac(unsigned x);
unsigned __sf_pack(unsigned sign, int exp, unsigned mant);
int __sf_unpack(unsigned a, unsigned *sign, int *exp, unsigned *mant);
unsigned __addsf3(unsigned a, unsigned b);
unsigned __subsf3(unsigned a, unsigned b);
unsigned __mulsf3(unsigned a, unsigned b);
unsigned __divsf3(unsigned a, unsigned b);
int __cmpsf2(unsigned a, unsigned b);
unsigned __floatsisf(int v);
unsigned __floatunsisf(unsigned x);
int __fixsfsi(unsigned f);
unsigned long long __extendsfdf2(unsigned f);
unsigned long long __df_make(unsigned lo, unsigned hi);
unsigned __df_sign(unsigned long long x);
unsigned __df_exp(unsigned long long x);
unsigned long long __df_frac(unsigned long long x);
unsigned long long __df_qnan(void);
unsigned long long __df_inf(unsigned sign);
int __df_is_nan(unsigned long long x);
int __df_is_inf(unsigned long long x);
unsigned long long __df_shift_right_jam(unsigned long long v, int dist);
unsigned long long __df_shift_right_jam128(unsigned long long hi, unsigned long long lo, int dist);
int __df_unpack(unsigned long long x, unsigned *sign, int *exp, unsigned long long *mant);
void __df_normalize(int *exp, unsigned long long *mant);
unsigned long long __df_pack(unsigned sign, int exp, unsigned long long mant);
unsigned long long __df_add_core(unsigned long long a, unsigned long long b);
void __u128_add(unsigned long long *hi, unsigned long long *lo, unsigned long long ahi, unsigned long long alo);
unsigned long long __adddf3(unsigned alo, unsigned ahi, unsigned blo, unsigned bhi);
unsigned long long __subdf3(unsigned alo, unsigned ahi, unsigned blo, unsigned bhi);
unsigned long long __muldf3(unsigned alo, unsigned ahi, unsigned blo, unsigned bhi);
unsigned long long __divdf3(unsigned alo, unsigned ahi, unsigned blo, unsigned bhi);
int __cmpdf2(unsigned alo, unsigned ahi, unsigned blo, unsigned bhi);
unsigned long long __floatsidf(int v);
unsigned long long __floatunsidf(unsigned v);
int __fixdfsi(unsigned lo, unsigned hi);
unsigned __truncdfsf2(unsigned lo, unsigned hi);
`;

function runtimeFunctionSource(name: string): string {
  const sig = FLOAT_RUNTIME_SOURCE.indexOf(`${name}(`);
  if (sig < 0) throw new Error(`float runtime source missing ${name}`);
  const start = FLOAT_RUNTIME_SOURCE.lastIndexOf('\n', sig) + 1;
  const open = FLOAT_RUNTIME_SOURCE.indexOf('{', sig);
  let depth = 0;
  for (let i = open; i < FLOAT_RUNTIME_SOURCE.length; i++) {
    const ch = FLOAT_RUNTIME_SOURCE[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return FLOAT_RUNTIME_SOURCE.slice(start, i + 1);
    }
  }
  throw new Error(`float runtime source has unterminated ${name}`);
}

function runtimeMember(name: string, functions: string[]): { name: string; data: Uint8Array } {
  const source = `${FLOAT_RUNTIME_PROTOTYPES}\n${functions.map(runtimeFunctionSource).join('\n\n')}\n`;
  return {
    name,
    data: encodeObject(compileObject(source, { name })),
  };
}

export function floatRuntimeArchive(): Archive {
  return parseArchive(
    encodeArchive({
      members: [
        runtimeMember('float-sf-common.o', [
          '__sf_abs',
          '__sf_sign',
          '__sf_exp',
          '__sf_frac',
          '__sf_pack',
          '__sf_unpack',
        ]),
        runtimeMember('float-sf-add.o', ['__addsf3']),
        runtimeMember('float-sf-sub.o', ['__subsf3']),
        runtimeMember('float-sf-mul.o', ['__mulsf3']),
        runtimeMember('float-sf-div.o', ['__divsf3']),
        runtimeMember('float-sf-cmp.o', ['__cmpsf2']),
        runtimeMember('float-sf-floatsi.o', ['__floatsisf']),
        runtimeMember('float-sf-floatunsi.o', ['__floatunsisf']),
        runtimeMember('float-sf-fixsi.o', ['__fixsfsi']),
        runtimeMember('float-df-common.o', [
          '__df_make',
          '__df_sign',
          '__df_exp',
          '__df_frac',
          '__df_qnan',
          '__df_inf',
          '__df_is_nan',
          '__df_is_inf',
          '__df_shift_right_jam',
          '__df_unpack',
          '__df_normalize',
          '__df_pack',
        ]),
        runtimeMember('float-df-add-core.o', ['__df_add_core']),
        runtimeMember('float-df-add.o', ['__adddf3']),
        runtimeMember('float-df-sub.o', ['__subdf3']),
        runtimeMember('float-df-mul.o', ['__df_shift_right_jam128', '__u128_add', '__muldf3']),
        runtimeMember('float-df-div.o', ['__divdf3']),
        runtimeMember('float-df-cmp.o', ['__cmpdf2']),
        runtimeMember('float-df-floatsi.o', ['__floatsidf']),
        runtimeMember('float-df-floatunsi.o', ['__floatunsidf']),
        runtimeMember('float-df-fixsi.o', ['__fixdfsi']),
        runtimeMember('float-extendsfdf.o', ['__extendsfdf2']),
        runtimeMember('float-truncdfsf.o', ['__truncdfsf2']),
      ],
    }),
  );
}
