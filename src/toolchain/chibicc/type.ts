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
  | 'ptr'
  | 'func'
  | 'array'
  | 'struct'
  | 'union';

export interface Member {
  name: string;
  ty: Type;
  offset: number;
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

export function pointerTo(base: Type): Type {
  return { kind: 'ptr', size: 4, align: 4, base };
}

export function arrayOf(base: Type, len: number): Type {
  return { kind: 'array', size: base.size * len, align: base.align, base, arrayLen: len };
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
  return ty.kind === 'char' || ty.kind === 'short' || ty.kind === 'int' || ty.kind === 'long';
}

export function isUnsignedInteger(ty: Type | undefined): boolean {
  return !!ty && isInteger(ty) && ty.isUnsigned === true;
}

export function usualArithmeticType(lhs: Type | undefined, rhs: Type | undefined): Type {
  return isUnsignedInteger(lhs) || isUnsignedInteger(rhs) ? tyUInt : tyInt;
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
  for (const stmt of node.body ?? []) addType(stmt);
  for (const arg of node.args ?? []) addType(arg);
  addType(node.funcExpr);

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
        ? node.lhs?.ty ?? tyInt
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
      node.ty = isUnsignedInteger(node.lhs?.ty) ? tyUInt : tyInt;
      return;
    case 'assign':
      node.ty = node.lhs?.ty ?? tyInt;
      return;
    case 'neg':
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
