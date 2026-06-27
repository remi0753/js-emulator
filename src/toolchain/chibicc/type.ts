// C type system for the chibicc-derived custom32 frontend.
//
// Ported from chibicc's `type.c`, but the sizes and alignments are the frozen
// custom32 ILP32 ABI (see docs/custom32-c-abi.md): char=1, short=2,
// int/long/pointer=4. `add_type` walks an AST and assigns a `Type` to every
// node, which the parser uses for pointer arithmetic scaling and the backend
// uses to pick byte vs word loads/stores. Keeping the ABI sizes here (not in the
// backend) is the deliberate split the roadmap calls for: the frontend stays
// portable, the target sizes live in one place.

import type { Node } from './parse.ts';

export type TypeKind =
  | 'void'
  | 'char'
  | 'short'
  | 'int'
  | 'long'
  | 'llong'
  | 'float'
  | 'double'
  | 'ptr'
  | 'func'
  | 'array'
  | 'struct'
  | 'union';

export interface Member {
  name: string;
  ty: Type;
  offset: number;
  bitOffset?: number;
  bitWidth?: number;
}

export interface Type {
  kind: TypeKind;
  size: number;
  align: number;
  isUnsigned?: boolean;
  // Element type for `ptr` and `array`.
  base?: Type;
  // Number of elements for `array`.
  arrayLen?: number;
  isVLA?: boolean;
  vlaLen?: Node;
  // Return and parameter types for `func`.
  returnType?: Type;
  params?: Type[];
  // Members for `struct` / `union`.
  members?: Member[];
  tag?: string;
}

export const tyVoid: Type = { kind: 'void', size: 1, align: 1 };
export const tyChar: Type = { kind: 'char', size: 1, align: 1 };
export const tyShort: Type = { kind: 'short', size: 2, align: 2 };
export const tyInt: Type = { kind: 'int', size: 4, align: 4 };
export const tyLong: Type = { kind: 'long', size: 4, align: 4 };
export const tyUChar: Type = { kind: 'char', size: 1, align: 1, isUnsigned: true };
export const tyUShort: Type = { kind: 'short', size: 2, align: 2, isUnsigned: true };
export const tyUInt: Type = { kind: 'int', size: 4, align: 4, isUnsigned: true };
export const tyULong: Type = { kind: 'long', size: 4, align: 4, isUnsigned: true };
// `long long` is 8 bytes but only 4-byte aligned in the custom32 ILP32 ABI.
export const tyLLong: Type = { kind: 'llong', size: 8, align: 4 };
export const tyULLong: Type = { kind: 'llong', size: 8, align: 4, isUnsigned: true };
export const tyFloat: Type = { kind: 'float', size: 4, align: 4 };
export const tyDouble: Type = { kind: 'double', size: 8, align: 4 };

export function pointerTo(base: Type): Type {
  return { kind: 'ptr', size: 4, align: 4, base };
}

export function arrayOf(base: Type, len: number): Type {
  return { kind: 'array', size: base.size * len, align: base.align, base, arrayLen: len };
}

export function vlaOf(base: Type, len: Node): Type {
  return { kind: 'array', size: 4, align: 4, base, isVLA: true, vlaLen: len };
}

export function funcType(returnType: Type, params: Type[]): Type {
  return { kind: 'func', size: 1, align: 1, returnType, params };
}

export function structType(members: Member[], size: number, align: number, tag?: string): Type {
  return { kind: 'struct', size, align, members, tag };
}

export function unionType(members: Member[], size: number, align: number, tag?: string): Type {
  return { kind: 'union', size, align, members, tag };
}

export function isInteger(ty: Type): boolean {
  return (
    ty.kind === 'char' ||
    ty.kind === 'short' ||
    ty.kind === 'int' ||
    ty.kind === 'long' ||
    ty.kind === 'llong'
  );
}

export function isAggregate(ty: Type | undefined): boolean {
  return !!ty && (ty.kind === 'struct' || ty.kind === 'union');
}

// A 64-bit integer (`long long`), held as a low/high 32-bit word pair.
export function is64(ty: Type | undefined): boolean {
  return !!ty && ty.kind === 'llong';
}

export function isUnsignedInteger(ty: Type | undefined): boolean {
  return !!ty && isInteger(ty) && ty.isUnsigned === true;
}

// Whether `ty` is still unsigned *after* integer promotion. char/short (signed
// or unsigned) promote to signed int because int holds all their values; only
// int/long-ranked unsigned types stay unsigned. This governs the signedness of
// division/remainder, shifts, and comparisons in the usual arithmetic
// conversions (see docs/custom32-c-abi.md).
export function isPromotedUnsigned(ty: Type | undefined): boolean {
  return isUnsignedInteger(ty) && (ty as Type).size >= 4;
}

export function usualArithmeticType(lhs: Type | undefined, rhs: Type | undefined): Type {
  // If either operand is 64-bit, the result is 64-bit (unsigned if either is).
  if (is64(lhs) || is64(rhs)) {
    return isUnsignedInteger(lhs) || isUnsignedInteger(rhs) ? tyULLong : tyLLong;
  }
  return isPromotedUnsigned(lhs) || isPromotedUnsigned(rhs) ? tyUInt : tyInt;
}

export function isPointerLike(ty: Type): boolean {
  return ty.kind === 'ptr' || ty.kind === 'array';
}

// The element type a pointer/array points at (1 byte for non-pointers, matching
// C's pointer-difference fallback).
export function elementType(ty: Type): Type {
  return ty.base ?? tyChar;
}

// Recursively assign a `.ty` to each node. Mirrors chibicc's add_type: it is
// idempotent and bottom-up, so callers can run it on any subtree.
export function addType(node: Node | null | undefined): void {
  if (!node || node.ty) return;

  addType(node.lhs);
  addType(node.rhs);
  addType(node.cond);
  addType(node.thenStmt);
  addType(node.els);
  addType(node.init);
  addType(node.inc);
  for (const c of node.cases ?? []) addType(c.body);
  addType(node.defaultCase);
  for (const stmt of node.body ?? []) addType(stmt);
  for (const arg of node.args ?? []) addType(arg);
  addType(node.funcExpr);
  for (const stmt of node.initStmts ?? []) addType(stmt);
  addType(node.vlaLen);

  switch (node.kind) {
    case 'add':
      if (isPointerLike(node.lhs?.ty ?? tyInt)) {
        node.ty = node.lhs?.ty ?? tyInt;
        return;
      }
      if (isPointerLike(node.rhs?.ty ?? tyInt)) {
        node.ty = node.rhs?.ty ?? tyInt;
        return;
      }
      node.ty = usualArithmeticType(node.lhs?.ty, node.rhs?.ty);
      return;
    case 'sub':
      node.ty = isPointerLike(node.lhs?.ty ?? tyInt)
        ? (node.lhs?.ty ?? tyInt)
        : usualArithmeticType(node.lhs?.ty, node.rhs?.ty);
      return;
    case 'mul':
    case 'div':
    case 'mod':
    case 'bitand':
    case 'bitor':
    case 'bitxor':
      node.ty = usualArithmeticType(node.lhs?.ty, node.rhs?.ty);
      return;
    case 'shl':
    case 'shr':
      if (is64(node.lhs?.ty)) {
        node.ty = isUnsignedInteger(node.lhs?.ty) ? tyULLong : tyLLong;
        return;
      }
      node.ty = isPromotedUnsigned(node.lhs?.ty) ? tyUInt : tyInt;
      return;
    case 'assign':
      node.ty = node.lhs?.ty ?? tyInt;
      return;
    case 'neg':
      // Negation keeps a 64-bit operand 64-bit; otherwise it promotes to int.
      node.ty = is64(node.lhs?.ty) ? (node.lhs?.ty ?? tyInt) : tyInt;
      return;
    case 'not':
    case 'eq':
    case 'ne':
    case 'lt':
    case 'le':
    case 'logand':
    case 'logor':
    case 'num':
      node.ty = tyInt;
      return;
    case 'var':
      node.ty = node.variable?.ty ?? tyInt;
      return;
    case 'funcall':
      node.ty = node.funcReturn ?? tyInt;
      return;
    case 'member':
      node.ty = node.member?.ty ?? tyInt;
      return;
    case 'compoundlit':
      node.ty = node.variable?.ty ?? tyInt;
      return;
    case 'vlaalloc':
      node.ty = tyVoid;
      return;
    case 'cast':
      node.ty = node.castType ?? tyInt;
      return;
    case 'addr': {
      // &array yields a pointer to the element type, matching C decay rules.
      const operand = node.lhs?.ty ?? tyInt;
      node.ty = operand.kind === 'array' ? pointerTo(elementType(operand)) : pointerTo(operand);
      return;
    }
    case 'deref': {
      const operand = node.lhs?.ty ?? tyInt;
      node.ty = isPointerLike(operand) ? elementType(operand) : tyInt;
      return;
    }
    default:
      node.ty = tyInt;
  }
}
