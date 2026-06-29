// custom32 backend for the vendored C-source chibicc frontend (Phase 34).
//
// The upstream chibicc codegen.c targets x86-64 and is intentionally *not*
// vendored. This file is the target-specific half of the guest compiler: it
// turns the typed AST produced by the upstream frontend (tokenize/preprocess/
// parse/type) into custom32 assembly that the guest compiler's in-process
// assembler/linker can consume.
//
// It is a C port of the maintained host backend `src/toolchain/chibicc/
// codegen.ts`; that TypeScript file is the authoritative reference for the
// custom32 ABI and instruction encodings. The traversal walks the *upstream*
// Node/Obj/Type model (chibicc.h), so a few things differ from codegen.ts:
//   - break/continue are already lowered to ND_GOTO by the parser, and the
//     loop brk/cont labels live on the node — no break/continue stacks.
//   - switch case labels are emitted by the ND_CASE statements in the body.
//   - local frame offsets are assigned here (assign_lvar_offsets), as in
//     upstream codegen.c, using the custom32 layout from parse.ts.
//
// ABI (see codegen.ts and docs/custom32-c-abi.md):
//   - R0 is the expression accumulator; R1/R2/R5/R7 are scratch.
//   - A software stack `__csp` (a 4-byte global owned by crt0) holds C
//     arguments and locals; the hardware SP only carries return addresses.
//   - R6 is the frame base. Parameters sit at negative offsets (the caller
//     pushed them), locals at positive offsets.
//   - Arguments are pushed right-to-left; the caller pops them after the call.
//   - 64-bit values live in the R0(low):R1(high) pair and route through the
//     __i64_*/__u64_* runtime helpers.
//
// Floating point is supported via a soft-float runtime (see the soft-float
// section below and runtimeFloat.ts): the backend carries IEEE-754 bits through
// the integer ABI and lowers every float op to a runtime call.
//
// Not yet ported (the frontend's own source does not need them to compile, and
// these are the next backend slices): VLAs/alloca, atomics (ND_CAS/ND_EXCH),
// and labels-as-values.

#include "upstream/chibicc.h"

// --- emission helpers -------------------------------------------------------

static FILE *output_file;

// The function whose body is being generated (parse.c keeps its own
// `current_fn` private, so the backend tracks its own).
static Obj *cur_fn;
static char *cur_return_label;

static void wr(char *s) { fputs(s, output_file); }

// Print an unsigned 32-bit value in decimal (the assembler accepts decimal
// immediates). Avoids depending on printf width/format specifiers.
static void wru(unsigned v) {
  char buf[12];
  int i = 0;
  if (v == 0) {
    fputc('0', output_file);
    return;
  }
  while (v) {
    buf[i++] = '0' + (v % 10);
    v /= 10;
  }
  while (i > 0)
    fputc(buf[--i], output_file);
}

// "  <text>\n" — an indented instruction with no operand interpolation.
static void ins(char *text) {
  wr("  ");
  wr(text);
  wr("\n");
}

// "  <opreg>, <imm>\n" e.g. ins_imm("MOV R7", 4) -> "  MOV R7, 4".
static void ins_imm(char *opreg, unsigned imm) {
  wr("  ");
  wr(opreg);
  wr(", ");
  wru(imm);
  wr("\n");
}

// "  <opreg>, <sym>\n" e.g. ins_sym("MOV R0", "foo") -> "  MOV R0, foo".
static void ins_sym(char *opreg, char *sym) {
  wr("  ");
  wr(opreg);
  wr(", ");
  wr(sym);
  wr("\n");
}

// "<label>:\n"
static void emit_label(char *label) {
  wr(label);
  wr(":\n");
}

// "  <op> <label>\n" e.g. jmp("JMP", ".L.cg.3") or jmp("CALL", "foo").
static void jmp(char *op, char *label) {
  wr("  ");
  wr(op);
  wr(" ");
  wr(label);
  wr("\n");
}

static int label_id = 0;

static char *new_label(void) { return format(".L.cg.%d", label_id++); }

// --- ABI primitives ---------------------------------------------------------

// Push R0 onto the software stack; advance __csp by 4.
static void push(void) {
  ins("LOAD R5, __csp");
  ins("STORER R5, R0");
  ins("MOV R7, 4");
  ins("ADD R5, R7");
  ins("STORE R5, __csp");
}

// Push a specific register onto the software stack; advance __csp by 4.
static void push_reg(char *reg) {
  ins("LOAD R5, __csp");
  ins_sym("STORER R5", reg);
  ins("MOV R7, 4");
  ins("ADD R5, R7");
  ins("STORE R5, __csp");
}

// Pop the top software-stack slot into `reg`; retreat __csp by 4.
static void pop(char *reg) {
  ins("LOAD R5, __csp");
  ins("MOV R7, 4");
  ins("SUB R5, R7");
  ins("STORE R5, __csp");
  wr("  LOADR ");
  wr(reg);
  wr(", R5\n");
}

// A balanced expression temporary: spilled and reloaded within the same
// expression, never read by a callee and never left live past a statement
// boundary, so it uses the single-instruction hardware PUSH/POP instead of the
// software __csp stack. Safe because the hardware stack already carries return
// addresses and saved frame pointers and is preserved across traps and context
// switches. Call arguments (read by the callee off __csp) keep using push()/
// push_reg(); the switch dispatch, which leaves its value live across the case
// jumps, stays on the leak-tolerant software stack.
static void push_tmp(void) { ins("PUSH R0"); }
static void push_tmp_reg(char *reg) {
  wr("  PUSH ");
  wr(reg);
  wr("\n");
}
static void pop_tmp(char *reg) {
  wr("  POP ");
  wr(reg);
  wr("\n");
}

static void adjust_csp(int delta) {
  ins("LOAD R5, __csp");
  ins_imm("MOV R7", delta >= 0 ? delta : -delta);
  ins(delta >= 0 ? "ADD R5, R7" : "SUB R5, R7");
  ins("STORE R5, __csp");
}

// --- type predicates --------------------------------------------------------

static bool is_unsigned_int(Type *ty) { return is_integer(ty) && ty->is_unsigned; }

// True only when an operand is still unsigned after integer promotion (char and
// short promote to signed int, so only width >= 4 keeps its unsignedness).
static bool is_promoted_unsigned(Type *ty) { return ty->is_unsigned && ty->size >= 4; }

// chibicc represents pointer/array duality with the `base` member.
static bool is_pointer_like(Type *ty) { return ty->base != NULL; }

static bool is_aggregate(Type *ty) {
  return ty && (ty->kind == TY_STRUCT || ty->kind == TY_UNION);
}

// long long: the only 8-byte integer type, carried in an R0:R1 pair. `long`
// is 32-bit on this LP32 target, so 64-bitness keys off the byte size.
static bool is64(Type *ty) { return ty && ty->kind == TY_LONG && ty->size == 8; }

static bool is_flonum_ty(Type *ty) {
  return ty && (ty->kind == TY_FLOAT || ty->kind == TY_DOUBLE || ty->kind == TY_LDOUBLE);
}

// binary32 lives in a single word; binary64 (and `long double`, which is the
// same 8-byte double on this target) lives in an R0:R1 pair / two stack slots.
static bool is_float_ty(Type *ty) { return ty && ty->kind == TY_FLOAT; }
static bool is_double_ty(Type *ty) {
  return ty && (ty->kind == TY_DOUBLE || ty->kind == TY_LDOUBLE);
}

static int slot_size(Type *ty) { return align_to(ty->size < 1 ? 1 : ty->size, 4); }

// --- forward declarations ---------------------------------------------------

static void gen_expr(Node *node);
static void gen_stmt(Node *node);
static void gen_addr(Node *node);
static bool value_is_simple(Node *node);
static bool addr_is_simple(Node *node);
static void gen_call(Node *node);
static void gen64_value(Node *node);
static void gen_value_as(Node *node, Type *ty);
static int push_call_arg(Node *arg);
static void gen_float_expr(Node *node);
static void gen_double_expr(Node *node);
static void gen_float_value(Node *node);
static void gen_double_value(Node *node);
static void gen_float_compare(Node *node);

// Soft-float helper used at compile time to fold a float literal's IEEE-754
// double bits down to binary32. The guest cc executable links the soft-float
// runtime, so this resolves like any other runtime call.
extern unsigned __truncdfsf2(unsigned lo, unsigned hi);

// --- lvalue addresses -------------------------------------------------------

static void emit_var_addr(Obj *var) {
  if (var->is_local) {
    int off = var->offset;
    ins("MOVR R0, R6");
    if (off > 0) {
      ins_imm("MOV R7", off);
      ins("ADD R0, R7");
    } else if (off < 0) {
      ins_imm("MOV R7", -off);
      ins("SUB R0, R7");
    }
  } else {
    ins_sym("MOV R0", var->name);
  }
}

static void gen_addr(Node *node) {
  switch (node->kind) {
  case ND_VAR:
    emit_var_addr(node->var);
    return;
  case ND_DEREF:
    gen_expr(node->lhs);
    return;
  case ND_COMMA:
    gen_expr(node->lhs);
    gen_addr(node->rhs);
    return;
  case ND_MEMBER:
    gen_addr(node->lhs);
    if (node->member->offset > 0) {
      ins_imm("MOV R7", node->member->offset);
      ins("ADD R0, R7");
    }
    return;
  case ND_FUNCALL:
    if (is_aggregate(node->ty)) {
      gen_call(node);
      return;
    }
    break;
  default:
    break;
  }
  error("codegen: not an lvalue");
}

// --- load / store -----------------------------------------------------------

static unsigned bit_mask(int width) {
  return width >= 32 ? 0xffffffffu : ((1u << width) - 1u);
}

// Sign-extend R0: if R0 < signBit it is positive, otherwise OR in the high bits.
static void sign_extend(unsigned sign_bit, unsigned high_bits) {
  char *done = new_label();
  ins_imm("MOV R7", sign_bit);
  ins("CMP R0, R7");
  jmp("JB", done);
  ins_imm("MOV R7", high_bits);
  ins("OR R0, R7");
  emit_label(done);
}

static void load_bitfield(Member *member) {
  int width = member->bit_width;
  int bit = member->bit_offset;
  unsigned mask = bit_mask(width);
  ins("LOADR R0, R0");
  if (bit > 0) {
    ins_imm("MOV R7", bit);
    ins("SHR R0, R7");
  }
  ins_imm("MOV R7", mask);
  ins("AND R0, R7");
  if (!is_unsigned_int(member->ty) && width > 0 && width < 32)
    sign_extend(1u << (width - 1), ~mask);
}

static void store_bitfield(Member *member) {
  int width = member->bit_width;
  int bit = member->bit_offset;
  unsigned mask = bit_mask(width);
  unsigned shifted = bit == 0 ? mask : (mask << bit);
  unsigned clear = ~shifted;
  ins("MOVR R2, R0");
  ins("LOADR R0, R1");
  ins_imm("MOV R7", clear);
  ins("AND R0, R7");
  ins("MOVR R5, R2");
  ins_imm("MOV R7", mask);
  ins("AND R5, R7");
  if (bit > 0) {
    ins_imm("MOV R7", bit);
    ins("SHL R5, R7");
  }
  ins("OR R0, R5");
  ins("STORER R1, R0");
  ins("MOVR R0, R2");
}

// R0 = address -> load the value at [R0] back into R0.
static void load(Node *node) {
  Type *ty = node->ty;
  if (ty->kind == TY_ARRAY) {
    return; // arrays decay to their address
  }
  if (ty->kind == TY_VLA) {
    ins("LOADR R0, R0");
    return;
  }
  if (ty->kind == TY_FUNC)
    return;
  if (node->kind == ND_MEMBER && node->member->is_bitfield) {
    load_bitfield(node->member);
    return;
  }
  if (ty->kind == TY_STRUCT || ty->kind == TY_UNION)
    error("codegen: cannot load an aggregate value directly");
  if (ty->kind == TY_CHAR)
    ins(is_unsigned_int(ty) ? "LB R0, R0" : "LBS R0, R0");
  else if (ty->kind == TY_BOOL)
    ins("LB R0, R0");
  else if (ty->kind == TY_SHORT)
    ins(is_unsigned_int(ty) ? "LH R0, R0" : "LHS R0, R0");
  else
    ins("LOADR R0, R0");
}

// Address in R1, value in R0.
static void store(Node *node) {
  Type *ty = node->ty;
  if (node->kind == ND_MEMBER && node->member->is_bitfield) {
    store_bitfield(node->member);
    return;
  }
  if (ty->kind == TY_CHAR || ty->kind == TY_BOOL)
    ins("SB R1, R0");
  else if (ty->kind == TY_SHORT)
    ins("SH R1, R0");
  else if (ty->kind == TY_STRUCT || ty->kind == TY_UNION)
    error("codegen: cannot assign an aggregate value directly");
  else
    ins("STORER R1, R0");
}

// Copy exactly `size` bytes from R0 (source) to R1 (destination). R0/R1 are
// not preserved.
static void copy_bytes(int size) {
  ins("MOVR R2, R0");
  ins("MOVR R5, R1");
  int remaining = size;
  while (remaining >= 4) {
    ins("LOADR R7, R2");
    ins("STORER R5, R7");
    ins("MOV R7, 4");
    ins("ADD R2, R7");
    ins("ADD R5, R7");
    remaining -= 4;
  }
  while (remaining > 0) {
    ins("LB R7, R2");
    ins("SB R5, R7");
    ins("MOV R7, 1");
    ins("ADD R2, R7");
    ins("ADD R5, R7");
    remaining--;
  }
}

// --- 64-bit (long long) -----------------------------------------------------

// R0 = address -> load the 64-bit value at [R0] into R0:R1.
static void load64(void) {
  ins("MOVR R2, R0");
  ins("LOADR R0, R2");
  ins("MOV R7, 4");
  ins("ADD R2, R7");
  ins("LOADR R1, R2");
}

// Sign- or zero-extend a 32-bit value in R0 into the high word R1.
static void widen64(Type *ty) {
  if (is_unsigned_int(ty) || (ty && is_pointer_like(ty))) {
    ins("MOV R1, 0");
    return;
  }
  ins("MOVR R1, R0");
  ins("MOV R7, 31");
  ins("SAR R1, R7");
}

// Produce a 64-bit value in R0:R1 from any operand, widening narrower ones.
static void gen64_value(Node *node) {
  if (is64(node->ty)) {
    gen_expr(node);
    return;
  }
  gen_expr(node);
  widen64(node->ty);
}

static char *helper64(Node *node) {
  switch (node->kind) {
  case ND_ADD:
    return "__i64_add";
  case ND_SUB:
    return "__i64_sub";
  case ND_MUL:
    return "__i64_mul";
  case ND_DIV:
    return is_unsigned_int(node->ty) ? "__u64_div" : "__i64_div";
  case ND_MOD:
    return is_unsigned_int(node->ty) ? "__u64_mod" : "__i64_mod";
  case ND_BITAND:
    return "__i64_and";
  case ND_BITOR:
    return "__i64_or";
  case ND_BITXOR:
    return "__i64_xor";
  default:
    error("codegen: no 64-bit helper");
  }
  return "";
}

static void gen64_assign(Node *node) {
  gen_addr(node->lhs);
  push_tmp();
  gen64_value(node->rhs);
  pop_tmp("R2");
  ins("STORER R2, R0");
  ins("MOV R7, 4");
  ins("ADD R2, R7");
  ins("STORER R2, R1");
}

// helper(a_lo, a_hi, b_lo, b_hi) -> R0:R1, args pushed right-to-left.
static void gen64_binary(Node *node, char *helper) {
  gen64_value(node->rhs);
  push_reg("R1");
  push_reg("R0");
  gen64_value(node->lhs);
  push_reg("R1");
  push_reg("R0");
  jmp("CALL", helper);
  adjust_csp(-16);
}

// helper(v_lo, v_hi, amount) -> R0:R1
static void gen64_shift(Node *node, char *helper) {
  gen_expr(node->rhs);
  push();
  gen64_value(node->lhs);
  push_reg("R1");
  push_reg("R0");
  jmp("CALL", helper);
  adjust_csp(-12);
}

// helper(v_lo, v_hi) -> R0:R1
static void gen64_unary(Node *operand, char *helper) {
  gen64_value(operand);
  push_reg("R1");
  push_reg("R0");
  jmp("CALL", helper);
  adjust_csp(-8);
}

// helper(a_lo, a_hi, b_lo, b_hi) -> R0 = -1/0/1, turned into a 0/1 boolean.
static void gen64_compare(Node *node) {
  bool uns = is_unsigned_int(node->lhs->ty) || is_unsigned_int(node->rhs->ty);
  gen64_value(node->rhs);
  push_reg("R1");
  push_reg("R0");
  gen64_value(node->lhs);
  push_reg("R1");
  push_reg("R0");
  jmp("CALL", uns ? "__u64_cmp" : "__i64_cmp");
  adjust_csp(-16);

  char *yes = new_label();
  char *done = new_label();
  char *op = "JZ";
  if (node->kind == ND_NE)
    op = "JNZ";
  else if (node->kind == ND_LT)
    op = "JL";
  else if (node->kind == ND_LE)
    op = "JLE";
  ins("MOV R7, 0");
  ins("CMP R0, R7");
  jmp(op, yes);
  ins("MOV R0, 0");
  jmp("JMP", done);
  emit_label(yes);
  ins("MOV R0, 1");
  emit_label(done);
}

static void gen64_expr(Node *node) {
  switch (node->kind) {
  case ND_NUM:
    ins_imm("MOV R0", (unsigned)node->val);
    ins_imm("MOV R1", (unsigned)(node->val >> 32));
    return;
  case ND_VAR:
  case ND_MEMBER:
    gen_addr(node);
    load64();
    return;
  case ND_DEREF:
    gen_expr(node->lhs);
    load64();
    return;
  case ND_ASSIGN:
    gen64_assign(node);
    return;
  case ND_CAST:
    gen_expr(node->lhs);
    if (!is64(node->lhs->ty))
      widen64(node->lhs->ty);
    return;
  case ND_FUNCALL:
    gen_call(node);
    return;
  case ND_NEG:
    gen64_unary(node->lhs, "__i64_neg");
    return;
  case ND_BITNOT:
    gen64_value(node->lhs);
    ins("MOV R7, 4294967295");
    ins("XOR R0, R7");
    ins("XOR R1, R7");
    return;
  case ND_SHL:
    gen64_shift(node, "__i64_shl");
    return;
  case ND_SHR:
    gen64_shift(node, is_unsigned_int(node->ty) ? "__i64_shr" : "__i64_sar");
    return;
  default:
    gen64_binary(node, helper64(node));
  }
}

// --- soft-float -------------------------------------------------------------
//
// custom32 has no FPU. Floating-point values are carried as raw IEEE-754 bits
// through the integer ABI (binary32 in one word, binary64 in an R0:R1 pair) and
// every operation is a call into the soft-float runtime (runtimeFloat.ts:
// __addsf3/__adddf3/__cmpsf2/__floatsisf/...). Mirrors the genFloat*/genDouble*
// methods in the maintained backend codegen.ts.

// A float/double literal's value is stored by the frontend as an 8-byte IEEE
// double at &node->fval (the bootstrap maps `long double` to `double`). Read
// the raw words directly so this stays free of host float ops; the binary32
// form is obtained by folding through the soft-float truncation helper.
static void double_literal_bits(Node *node, unsigned *lo, unsigned *hi) {
  unsigned *p = (unsigned *)&node->fval;
  *lo = p[0];
  *hi = p[1];
}

static unsigned float_literal_bits(Node *node) {
  unsigned lo, hi;
  double_literal_bits(node, &lo, &hi);
  return __truncdfsf2(lo, hi);
}

static char *float_binary_helper(Node *node, bool dbl) {
  switch (node->kind) {
  case ND_ADD:
    return dbl ? "__adddf3" : "__addsf3";
  case ND_SUB:
    return dbl ? "__subdf3" : "__subsf3";
  case ND_MUL:
    return dbl ? "__muldf3" : "__mulsf3";
  case ND_DIV:
    return dbl ? "__divdf3" : "__divsf3";
  default:
    error("codegen: no soft-float helper");
  }
  return "";
}

// helper(b, a) for binary32: rhs then lhs pushed (one word each).
static void gen_float_binary(Node *node) {
  gen_float_value(node->rhs);
  push();
  gen_float_value(node->lhs);
  push();
  jmp("CALL", float_binary_helper(node, false));
  adjust_csp(-8);
}

// helper(b_lo, b_hi, a_lo, a_hi) for binary64, args pushed right-to-left.
static void gen_double_binary(Node *node) {
  gen_double_value(node->rhs);
  push_reg("R1");
  push_reg("R0");
  gen_double_value(node->lhs);
  push_reg("R1");
  push_reg("R0");
  jmp("CALL", float_binary_helper(node, true));
  adjust_csp(-16);
}

// Produce a binary32 value in R0 for a node already typed `float`.
static void gen_float_expr(Node *node) {
  switch (node->kind) {
  case ND_NUM:
    ins_imm("MOV R0", float_literal_bits(node));
    return;
  case ND_VAR:
  case ND_MEMBER:
    gen_addr(node);
    load(node);
    return;
  case ND_DEREF:
    gen_expr(node->lhs);
    load(node);
    return;
  case ND_ASSIGN:
    gen_addr(node->lhs);
    push_tmp();
    gen_float_value(node->rhs);
    pop_tmp("R1");
    store(node->lhs);
    return;
  case ND_CAST:
    gen_float_value(node->lhs);
    return;
  case ND_FUNCALL:
    gen_call(node);
    return;
  case ND_NEG:
    gen_float_value(node->lhs);
    ins("MOV R7, 2147483648");
    ins("XOR R0, R7");
    return;
  default:
    gen_float_binary(node);
  }
}

// Produce a binary64 value in R0(low):R1(high) for a node already typed
// `double`.
static void gen_double_expr(Node *node) {
  switch (node->kind) {
  case ND_NUM: {
    unsigned lo, hi;
    double_literal_bits(node, &lo, &hi);
    ins_imm("MOV R0", lo);
    ins_imm("MOV R1", hi);
    return;
  }
  case ND_VAR:
  case ND_MEMBER:
    gen_addr(node);
    load64();
    return;
  case ND_DEREF:
    gen_expr(node->lhs);
    load64();
    return;
  case ND_ASSIGN:
    gen_addr(node->lhs);
    push_tmp();
    gen_double_value(node->rhs);
    pop_tmp("R2");
    ins("STORER R2, R0");
    ins("MOV R7, 4");
    ins("ADD R2, R7");
    ins("STORER R2, R1");
    return;
  case ND_CAST:
    gen_double_value(node->lhs);
    return;
  case ND_FUNCALL:
    gen_call(node);
    return;
  case ND_NEG:
    gen_double_value(node->lhs);
    ins("MOV R7, 2147483648");
    ins("XOR R1, R7");
    return;
  default:
    gen_double_binary(node);
  }
}

// Evaluate any node and leave a binary32 value in R0, converting from double or
// integer source types as needed.
static void gen_float_value(Node *node) {
  if (is_float_ty(node->ty)) {
    gen_float_expr(node);
    return;
  }
  if (is_double_ty(node->ty)) {
    gen_double_value(node);
    push_reg("R1");
    push_reg("R0");
    jmp("CALL", "__truncdfsf2");
    adjust_csp(-8);
    return;
  }
  gen_expr(node);
  push();
  jmp("CALL",
      is_unsigned_int(node->ty) || is_pointer_like(node->ty) ? "__floatunsisf" : "__floatsisf");
  adjust_csp(-4);
}

// Evaluate any node and leave a binary64 value in R0:R1.
static void gen_double_value(Node *node) {
  if (is_double_ty(node->ty)) {
    gen_double_expr(node);
    return;
  }
  if (is_float_ty(node->ty)) {
    gen_float_value(node);
    push();
    jmp("CALL", "__extendsfdf2");
    adjust_csp(-4);
    return;
  }
  gen_expr(node);
  push();
  jmp("CALL",
      is_unsigned_int(node->ty) || is_pointer_like(node->ty) ? "__floatunsidf" : "__floatsidf");
  adjust_csp(-4);
}

// Float/double ==, !=, <, <=: the runtime returns -1/0/1, turned into a 0/1
// boolean by the same sign test the integer path uses.
static void gen_float_compare(Node *node) {
  bool dbl = is_double_ty(node->lhs->ty) || is_double_ty(node->rhs->ty);
  if (dbl) {
    gen_double_value(node->rhs);
    push_reg("R1");
    push_reg("R0");
    gen_double_value(node->lhs);
    push_reg("R1");
    push_reg("R0");
    jmp("CALL", "__cmpdf2");
    adjust_csp(-16);
  } else {
    gen_float_value(node->rhs);
    push();
    gen_float_value(node->lhs);
    push();
    jmp("CALL", "__cmpsf2");
    adjust_csp(-8);
  }
  char *yes = new_label();
  char *done = new_label();
  char *op = "JZ";
  if (node->kind == ND_NE)
    op = "JNZ";
  else if (node->kind == ND_LT)
    op = "JL";
  else if (node->kind == ND_LE)
    op = "JLE";
  ins("MOV R7, 0");
  ins("CMP R0, R7");
  jmp(op, yes);
  ins("MOV R0, 0");
  jmp("JMP", done);
  emit_label(yes);
  ins("MOV R0, 1");
  emit_label(done);
}

// --- aggregates -------------------------------------------------------------

static void gen_aggregate_assign(Node *node) {
  int size = node->lhs->ty->size;
  if (size < 1)
    size = 1;
  gen_addr(node->lhs);
  push_tmp();
  gen_addr(node->rhs);
  pop_tmp("R1");
  copy_bytes(size);
  ins("MOVR R0, R1");
}

// The caller pushed the return-buffer address last, so it sits at R6-4.
static void return_aggregate(Node *expr) {
  int size = cur_fn->ty->return_ty->size;
  if (size < 1)
    size = expr->ty->size;
  if (size < 1)
    size = 1;
  ins("MOVR R1, R6");
  ins("MOV R7, 4");
  ins("SUB R1, R7");
  ins("LOADR R1, R1");
  push_tmp_reg("R1");
  gen_addr(expr);
  pop_tmp("R1");
  copy_bytes(size);
  ins("MOVR R0, R1");
}

// --- calls ------------------------------------------------------------------

static int push_call_arg(Node *arg) {
  if (is_float_ty(arg->ty)) {
    gen_float_value(arg);
    push();
    return 1;
  }
  if (is_double_ty(arg->ty)) {
    gen_double_value(arg);
    push_reg("R0"); // low word (lower address)
    push_reg("R1"); // high word
    return 2;
  }
  if (is64(arg->ty)) {
    gen64_value(arg);
    push_reg("R0"); // low word (lower address)
    push_reg("R1"); // high word
    return 2;
  }
  if (is_aggregate(arg->ty)) {
    gen_addr(arg);
    ins("LOAD R1, __csp");
    int size = arg->ty->size;
    if (size < 1)
      size = 1;
    copy_bytes(size);
    int bytes = slot_size(arg->ty);
    adjust_csp(bytes);
    return bytes / 4;
  }
  gen_expr(arg);
  push();
  return 1;
}

// Evaluate the call's arguments left-to-right and land them in `regs`. Extra
// arguments beyond `nregs` are discarded; unused registers are zeroed. Used
// only for the fixed-arity target intrinsics below.
static void into_regs(Node *node, char **regs, int nregs) {
  int n = 0;
  for (Node *a = node->args; a; a = a->next) {
    gen_expr(a);
    push_tmp();
    n++;
  }
  while (n > nregs) {
    pop_tmp("R7");
    n--;
  }
  for (int i = n - 1; i >= 0; i--)
    pop_tmp(regs[i]);
  for (int i = n; i < nregs; i++)
    ins_imm(format("MOV %s", regs[i]), 0);
}

// Target intrinsics recognized by name: `__syscall` (the userland trap) plus a
// few raw device/CPU primitives. Mirrors the bootstrap backend's genBuiltin
// (src/toolchain/chibicc/codegen.ts). Returns true when the call was lowered
// inline; false to fall back to an ordinary CALL.
static bool gen_intrinsic(Node *node) {
  Node *fn = node->lhs;
  if (!fn || fn->kind != ND_VAR)
    return false;
  char *name = fn->var->name;
  char *r4[4] = {"R0", "R1", "R2", "R3"};
  char *r2[2] = {"R1", "R2"};
  char *r1[1] = {"R1"};
  if (!strcmp(name, "__syscall")) {
    into_regs(node, r4, 4);
    ins("INT 128");
    return true;
  }
  if (!strcmp(name, "__out")) {
    into_regs(node, r2, 2);
    ins("OUT R1, R2");
    ins("MOV R0, 0");
    return true;
  }
  if (!strcmp(name, "__in")) {
    into_regs(node, r1, 1);
    ins("IN R0, R1");
    return true;
  }
  if (!strcmp(name, "__halt")) {
    ins("HLT");
    ins("MOV R0, 0");
    return true;
  }
  if (!strcmp(name, "__iret")) {
    ins("IRET");
    ins("MOV R0, 0");
    return true;
  }
  if (!strcmp(name, "__lidt")) {
    into_regs(node, r1, 1);
    ins("LIDT R1");
    ins("MOV R0, 0");
    return true;
  }
  if (!strcmp(name, "__lksp")) {
    into_regs(node, r1, 1);
    ins("LKSP R1");
    ins("MOV R0, 0");
    return true;
  }
  if (!strcmp(name, "__stmr")) {
    into_regs(node, r1, 1);
    ins("STMR R1");
    ins("MOV R0, 0");
    return true;
  }
  if (!strcmp(name, "__lptbr")) {
    into_regs(node, r1, 1);
    ins("LPTBR R1");
    ins("MOV R0, 0");
    return true;
  }
  if (!strcmp(name, "__pgon")) {
    ins("PGON");
    ins("MOV R0, 0");
    return true;
  }
  if (!strcmp(name, "__pgoff")) {
    ins("PGOFF");
    ins("MOV R0, 0");
    return true;
  }
  if (!strcmp(name, "__rdpfla")) {
    ins("RDPFLA R0");
    return true;
  }
  if (!strcmp(name, "__rderr")) {
    ins("RDERR R0");
    return true;
  }
  if (!strcmp(name, "__ei")) {
    ins("EI");
    ins("MOV R0, 0");
    return true;
  }
  if (!strcmp(name, "__di")) {
    ins("DI");
    ins("MOV R0, 0");
    return true;
  }
  return false;
}

static void gen_call(Node *node) {
  if (gen_intrinsic(node))
    return;
  int n = 0;
  for (Node *a = node->args; a; a = a->next)
    n++;
  Node **argv = calloc(n + 1, sizeof(Node *));
  int idx = 0;
  for (Node *a = node->args; a; a = a->next)
    argv[idx++] = a;

  // Arguments are pushed right-to-left so the first parameter lands closest to
  // the callee's frame base.
  int words = 0;
  for (int i = n - 1; i >= 0; i--)
    words += push_call_arg(argv[i]);

  bool agg = is_aggregate(node->ty);
  if (agg) {
    if (!node->ret_buffer)
      error("codegen: aggregate call without a return buffer");
    emit_var_addr(node->ret_buffer);
    push();
    words += 1;
  }

  Node *fnexpr = node->lhs;
  if (fnexpr->kind == ND_VAR && fnexpr->var->ty->kind == TY_FUNC) {
    jmp("CALL", fnexpr->var->name);
  } else {
    gen_expr(fnexpr);
    ins("CALLR R0");
  }

  if (words > 0)
    adjust_csp(-words * 4);
  if (agg)
    emit_var_addr(node->ret_buffer);
  free(argv);
}

// --- conditions, logical, comparison ----------------------------------------

// Evaluate a condition's truthiness into R0. A 64-bit operand folds both words.
static void gen_cond(Node *node) {
  gen_expr(node);
  if (is64(node->ty)) {
    ins("OR R0, R1");
  } else if (is_float_ty(node->ty)) {
    // Truthy iff any bit except the sign is set (also makes -0.0 false).
    ins("MOV R7, 2147483647");
    ins("AND R0, R7");
  } else if (is_double_ty(node->ty)) {
    ins("MOV R7, 2147483647");
    ins("AND R1, R7");
    ins("OR R0, R1");
  }
}

static void gen_compare(Node *node) {
  char *yes = new_label();
  char *done = new_label();
  bool uns = is_promoted_unsigned(node->lhs->ty) || is_promoted_unsigned(node->rhs->ty);
  char *op = "JZ";
  if (node->kind == ND_NE)
    op = "JNZ";
  else if (node->kind == ND_LT)
    op = uns ? "JB" : "JL";
  else if (node->kind == ND_LE)
    op = uns ? "JBE" : "JLE";
  ins("CMP R0, R1");
  jmp(op, yes);
  ins("MOV R0, 0");
  jmp("JMP", done);
  emit_label(yes);
  ins("MOV R0, 1");
  emit_label(done);
}

// A plain 32-bit integer constant: `MOV R0/R1, value` reproduces it with no
// stack traffic. Excludes float/64-bit literals, which take other paths.
static bool is_int_const(Node *node) {
  return node->kind == ND_NUM && !is_flonum_ty(node->ty) && !is64(node->ty);
}

static bool is_commutative(NodeKind kind) {
  return kind == ND_ADD || kind == ND_MUL || kind == ND_BITAND || kind == ND_BITOR ||
         kind == ND_BITXOR;
}

// True when gen_expr(node) writes only R0 and the R7 scratch — never R1-R5. A
// simple value can be (re)computed while another operand is held live in R1,
// removing the software-stack spill/reload around a binary operator.
static bool value_is_simple(Node *node) {
  if (is_flonum_ty(node->ty) || is64(node->ty))
    return false;
  switch (node->kind) {
  case ND_NUM:
  case ND_VAR:
    return true;
  case ND_MEMBER:
    return !node->member->is_bitfield && addr_is_simple(node);
  case ND_DEREF:
    return value_is_simple(node->lhs);
  case ND_ADDR:
    return addr_is_simple(node->lhs);
  default:
    return false;
  }
}

// True when gen_addr(node) writes only R0 and the R7 scratch.
static bool addr_is_simple(Node *node) {
  switch (node->kind) {
  case ND_VAR:
    return true;
  case ND_MEMBER:
    return !node->member->is_bitfield && addr_is_simple(node->lhs);
  case ND_DEREF:
    return value_is_simple(node->lhs);
  default:
    return false;
  }
}

static void gen_binary(Node *node) {
  if (node->kind == ND_EQ || node->kind == ND_NE || node->kind == ND_LT || node->kind == ND_LE) {
    if (is_flonum_ty(node->lhs->ty) || is_flonum_ty(node->rhs->ty)) {
      gen_float_compare(node);
      return;
    }
    if (is64(node->lhs->ty) || is64(node->rhs->ty)) {
      gen64_compare(node);
      return;
    }
  }
  // The operator switch below expects lhs in R0 and rhs in R1. The general way
  // to get there is to evaluate rhs, spill it to the software stack, evaluate
  // lhs, then reload rhs — two memory round-trips. The fast paths below avoid
  // the spill whenever an operand is a constant (fold it straight into R1) or
  // the left operand is a simple leaf that provably touches only R0/R7, so a
  // previously computed rhs can stay live in R1.
  if (is_int_const(node->rhs)) {
    gen_expr(node->lhs);
    ins_imm("MOV R1", (unsigned)node->rhs->val);
  } else if (is_int_const(node->lhs) && is_commutative(node->kind)) {
    gen_expr(node->rhs);
    ins_imm("MOV R1", (unsigned)node->lhs->val);
  } else if (value_is_simple(node->lhs)) {
    gen_expr(node->rhs);
    ins("MOVR R1, R0");
    gen_expr(node->lhs);
  } else {
    // Evaluate rhs first and stash it, then lhs, so R0 = lhs and R1 = rhs.
    gen_expr(node->rhs);
    push_tmp();
    gen_expr(node->lhs);
    pop_tmp("R1");
  }

  switch (node->kind) {
  case ND_ADD:
    ins("ADD R0, R1");
    return;
  case ND_SUB:
    ins("SUB R0, R1");
    return;
  case ND_MUL:
    ins("MUL R0, R1");
    return;
  case ND_DIV:
    ins(is_unsigned_int(node->ty) ? "DIV R0, R1" : "IDIV R0, R1");
    return;
  case ND_MOD:
    ins(is_unsigned_int(node->ty) ? "MOD R0, R1" : "IMOD R0, R1");
    return;
  case ND_BITAND:
    ins("AND R0, R1");
    return;
  case ND_BITOR:
    ins("OR R0, R1");
    return;
  case ND_BITXOR:
    ins("XOR R0, R1");
    return;
  case ND_SHL:
    ins("SHL R0, R1");
    return;
  case ND_SHR:
    ins(is_promoted_unsigned(node->lhs->ty) ? "SHR R0, R1" : "SAR R0, R1");
    return;
  case ND_EQ:
  case ND_NE:
  case ND_LT:
  case ND_LE:
    gen_compare(node);
    return;
  default:
    error("codegen: unsupported operator");
  }
}

static void gen_logical(Node *node) {
  bool is_and = node->kind == ND_LOGAND;
  char *set = new_label();
  char *done = new_label();
  gen_cond(node->lhs);
  ins("MOV R7, 0");
  ins("CMP R0, R7");
  jmp(is_and ? "JZ" : "JNZ", set);
  gen_cond(node->rhs);
  ins("MOV R7, 0");
  ins("CMP R0, R7");
  jmp(is_and ? "JZ" : "JNZ", set);
  ins(is_and ? "MOV R0, 1" : "MOV R0, 0");
  jmp("JMP", done);
  emit_label(set);
  ins(is_and ? "MOV R0, 0" : "MOV R0, 1");
  emit_label(done);
}

// `cond ? then : els`. Both arms are generated with their own value type.
static void gen_conditional(Node *node) {
  char *els = new_label();
  char *end = new_label();
  gen_cond(node->cond);
  ins("MOV R7, 0");
  ins("CMP R0, R7");
  jmp("JZ", els);
  gen_expr(node->then);
  jmp("JMP", end);
  emit_label(els);
  gen_expr(node->els);
  emit_label(end);
}

// --- casts ------------------------------------------------------------------

static void cast_to(Type *ty) {
  if (!ty)
    return;
  if (ty->kind == TY_BOOL) {
    char *t = new_label();
    char *d = new_label();
    ins("MOV R7, 0");
    ins("CMP R0, R7");
    jmp("JNZ", t);
    ins("MOV R0, 0");
    jmp("JMP", d);
    emit_label(t);
    ins("MOV R0, 1");
    emit_label(d);
    return;
  }
  if (ty->kind == TY_CHAR) {
    ins("MOV R7, 255");
    ins("AND R0, R7");
    if (!is_unsigned_int(ty))
      sign_extend(0x80, 0xffffff00);
    return;
  }
  if (ty->kind == TY_SHORT) {
    ins("MOV R7, 65535");
    ins("AND R0, R7");
    if (!is_unsigned_int(ty))
      sign_extend(0x8000, 0xffff0000);
  }
}

static void gen_value_as(Node *node, Type *ty) {
  if (!ty) {
    gen_expr(node);
    return;
  }
  if (is_float_ty(ty)) {
    gen_float_value(node);
    return;
  }
  if (is_double_ty(ty)) {
    gen_double_value(node);
    return;
  }
  if (is64(ty)) {
    gen64_value(node);
    return;
  }
  // Float/double -> integer: the runtime returns a 32-bit int in R0; narrow it
  // further if the destination is char/short.
  if (is_float_ty(node->ty)) {
    gen_float_value(node);
    push();
    jmp("CALL", "__fixsfsi");
    adjust_csp(-4);
    cast_to(ty);
    return;
  }
  if (is_double_ty(node->ty)) {
    gen_double_value(node);
    push_reg("R1");
    push_reg("R0");
    jmp("CALL", "__fixdfsi");
    adjust_csp(-8);
    cast_to(ty);
    return;
  }
  gen_expr(node);
  cast_to(ty);
}

// --- expressions ------------------------------------------------------------

static void gen_memzero(Node *node) {
  emit_var_addr(node->var);
  int size = node->var->ty->size;
  if (size < 1)
    size = 1;
  ins("MOVR R2, R0");
  ins("MOV R0, 0");
  int remaining = size;
  while (remaining >= 4) {
    ins("STORER R2, R0");
    ins("MOV R7, 4");
    ins("ADD R2, R7");
    remaining -= 4;
  }
  while (remaining > 0) {
    ins("SB R2, R0");
    ins("MOV R7, 1");
    ins("ADD R2, R7");
    remaining--;
  }
}

static void gen_expr(Node *node) {
  // The comma operator and `?:` decide their result width by the producing arm.
  if (node->kind == ND_COMMA) {
    gen_expr(node->lhs);
    gen_expr(node->rhs);
    return;
  }
  if (node->kind == ND_COND) {
    gen_conditional(node);
    return;
  }
  // 64-bit values take the R0:R1 pair path.
  if (is64(node->ty)) {
    gen64_expr(node);
    return;
  }
  // Floating point: binary32 in R0, binary64 in R0:R1, via the soft-float
  // runtime (see the soft-float section above).
  if (is_float_ty(node->ty)) {
    gen_float_expr(node);
    return;
  }
  if (is_double_ty(node->ty)) {
    gen_double_expr(node);
    return;
  }

  switch (node->kind) {
  case ND_NULL_EXPR:
    return;
  case ND_NUM:
    ins_imm("MOV R0", (unsigned)node->val);
    return;
  case ND_MEMZERO:
    gen_memzero(node);
    return;
  case ND_VAR:
  case ND_MEMBER:
    gen_addr(node);
    load(node);
    return;
  case ND_ADDR:
    gen_addr(node->lhs);
    return;
  case ND_DEREF:
    gen_expr(node->lhs);
    load(node);
    return;
  case ND_ASSIGN:
    if (is_aggregate(node->lhs->ty)) {
      gen_aggregate_assign(node);
      return;
    }
    gen_addr(node->lhs);
    if (value_is_simple(node->rhs)) {
      // Hold the destination address in R1 while a simple rhs recomputes R0,
      // skipping the software-stack round-trip. store() wants R1 = address.
      ins("MOVR R1, R0");
      gen_expr(node->rhs);
    } else {
      push_tmp();
      gen_expr(node->rhs);
      pop_tmp("R1");
    }
    store(node->lhs);
    return;
  case ND_STMT_EXPR:
    for (Node *n = node->body; n; n = n->next)
      gen_stmt(n);
    return;
  case ND_FUNCALL:
    gen_call(node);
    return;
  case ND_CAST:
    gen_value_as(node->lhs, node->ty);
    return;
  case ND_NEG:
    gen_expr(node->lhs);
    ins("MOV R1, 0");
    ins("SUB R1, R0");
    ins("MOVR R0, R1");
    return;
  case ND_BITNOT:
    gen_expr(node->lhs);
    ins("MOV R7, 4294967295");
    ins("XOR R0, R7");
    return;
  case ND_NOT: {
    char *yes = new_label();
    char *done = new_label();
    gen_cond(node->lhs);
    ins("MOV R7, 0");
    ins("CMP R0, R7");
    jmp("JZ", yes);
    ins("MOV R0, 0");
    jmp("JMP", done);
    emit_label(yes);
    ins("MOV R0, 1");
    emit_label(done);
    return;
  }
  case ND_LOGAND:
  case ND_LOGOR:
    gen_logical(node);
    return;
  case ND_VLA_PTR:
  case ND_CAS:
  case ND_EXCH:
  case ND_GOTO_EXPR:
  case ND_LABEL_VAL:
    error("codegen: construct not yet supported");
    return;
  default:
    gen_binary(node);
  }
}

// --- statements -------------------------------------------------------------

static void gen_asm(Node *node) {
  char *s = node->asm_str;
  int i = 0;
  while (s[i]) {
    int start = i;
    while (s[i] && s[i] != '\n')
      i++;
    wr("  ");
    for (int j = start; j < i; j++)
      fputc(s[j], output_file);
    wr("\n");
    if (s[i] == '\n')
      i++;
  }
}

static void gen_stmt(Node *node) {
  switch (node->kind) {
  case ND_IF: {
    char *els = new_label();
    char *end = new_label();
    gen_cond(node->cond);
    ins("MOV R7, 0");
    ins("CMP R0, R7");
    jmp("JZ", els);
    gen_stmt(node->then);
    jmp("JMP", end);
    emit_label(els);
    if (node->els)
      gen_stmt(node->els);
    emit_label(end);
    return;
  }
  case ND_FOR: {
    if (node->init)
      gen_stmt(node->init);
    char *top = new_label();
    emit_label(top);
    if (node->cond) {
      gen_cond(node->cond);
      ins("MOV R7, 0");
      ins("CMP R0, R7");
      jmp("JZ", node->brk_label);
    }
    gen_stmt(node->then);
    emit_label(node->cont_label);
    if (node->inc)
      gen_expr(node->inc);
    jmp("JMP", top);
    emit_label(node->brk_label);
    return;
  }
  case ND_DO: {
    char *top = new_label();
    emit_label(top);
    gen_stmt(node->then);
    emit_label(node->cont_label);
    gen_cond(node->cond);
    ins("MOV R7, 0");
    ins("CMP R0, R7");
    jmp("JNZ", top);
    emit_label(node->brk_label);
    return;
  }
  case ND_SWITCH: {
    // The dispatch keeps the test value live on the software stack across the
    // case jumps (a matched case branches away with the value still pushed); the
    // epilogue's `STORE R6, __csp` reclaims that slot, so this stays on __csp
    // rather than the balanced hardware-temp path.
    gen_expr(node->cond);
    push();
    for (Node *c = node->case_next; c; c = c->case_next) {
      pop("R0");
      push();
      if (c->begin == c->end) {
        ins_imm("MOV R7", (unsigned)c->begin);
        ins("CMP R0, R7");
        jmp("JZ", c->label);
      } else {
        // GNU case range [begin, end]: (val - begin) <= (end - begin), unsigned.
        ins_imm("MOV R7", (unsigned)c->begin);
        ins("SUB R0, R7");
        ins_imm("MOV R7", (unsigned)(c->end - c->begin));
        ins("CMP R0, R7");
        jmp("JBE", c->label);
      }
    }
    pop("R0");
    if (node->default_case)
      jmp("JMP", node->default_case->label);
    else
      jmp("JMP", node->brk_label);
    gen_stmt(node->then);
    emit_label(node->brk_label);
    return;
  }
  case ND_CASE:
    emit_label(node->label);
    gen_stmt(node->lhs);
    return;
  case ND_BLOCK:
    for (Node *n = node->body; n; n = n->next)
      gen_stmt(n);
    return;
  case ND_GOTO:
    jmp("JMP", node->unique_label);
    return;
  case ND_LABEL:
    emit_label(node->unique_label);
    gen_stmt(node->lhs);
    return;
  case ND_RETURN:
    if (node->lhs) {
      if (is_aggregate(cur_fn->ty->return_ty))
        return_aggregate(node->lhs);
      else
        gen_value_as(node->lhs, cur_fn->ty->return_ty);
    } else {
      ins("MOV R0, 0");
    }
    jmp("JMP", cur_return_label);
    return;
  case ND_EXPR_STMT:
    gen_expr(node->lhs);
    return;
  case ND_ASM:
    gen_asm(node);
    return;
  default:
    gen_expr(node);
  }
}

// --- frame layout -----------------------------------------------------------

// Assign frame offsets: locals at positive offsets growing upward, parameters
// at negative offsets (the caller pushed them, right-to-left). Mirrors
// parse.ts assignOffsets. Upstream keeps parameters in the locals list too, so
// the positive pass also covers them; the negative pass then overrides the
// parameter slots (a few harmless padding bytes is the only cost).
static void assign_lvar_offsets(Obj *fn) {
  int top = 0;
  for (Obj *l = fn->locals; l; l = l->next) {
    int a = l->align < 4 ? l->align : 4;
    top = align_to(top, a);
    l->offset = top;
    top += align_to(l->ty->size < 1 ? 1 : l->ty->size, 4);
  }
  fn->stack_size = align_to(top, 4);

  // A hidden return-buffer pointer occupies the slot closest to the frame base
  // (offset -4) when the function returns an aggregate.
  int acc = is_aggregate(fn->ty->return_ty) ? 4 : 0;
  for (Obj *p = fn->params; p; p = p->next) {
    acc += align_to(p->ty->size < 1 ? 1 : p->ty->size, 4);
    p->offset = -acc;
  }
}

// --- functions and globals --------------------------------------------------

static void gen_function(Obj *fn) {
  cur_fn = fn;
  cur_return_label = new_label();
  emit_label(fn->name);
  ins("PUSH R6");
  ins("LOAD R6, __csp");
  if (fn->stack_size > 0) {
    ins("MOVR R5, R6");
    ins_imm("MOV R7", fn->stack_size);
    ins("ADD R5, R7");
    ins("STORE R5, __csp");
  }

  if (fn->body)
    gen_stmt(fn->body);

  // Falling off the end returns 0 (the C `main` rule), keeping R0 defined.
  ins("MOV R0, 0");
  emit_label(cur_return_label);
  ins("STORE R6, __csp");
  ins("POP R6");
  ins("RET");
  cur_fn = NULL;
}

// Find the relocation whose offset equals `pos`, or NULL.
static Relocation *reloc_at(Relocation *rel, int pos) {
  for (Relocation *r = rel; r; r = r->next)
    if (r->offset == pos)
      return r;
  return NULL;
}

// The smallest relocation offset strictly greater than `pos`, or `fallback`.
static int next_reloc_offset(Relocation *rel, int pos, int fallback) {
  int best = fallback;
  for (Relocation *r = rel; r; r = r->next)
    if (r->offset > pos && r->offset < best)
      best = r->offset;
  return best;
}

// Emit an initializer image, splicing in `.word symbol+addend` (4 bytes, the
// assembler turns the symbol operand into an abs32 relocation) at each
// relocation slot and emitting the surrounding bytes as `.byte` runs.
static void emit_init_data(char *buf, int len, Relocation *rel) {
  int i = 0;
  while (i < len) {
    Relocation *r = reloc_at(rel, i);
    if (r) {
      wr("  .word ");
      wr(*r->label);
      if (r->addend > 0) {
        wr("+");
        wru((unsigned)r->addend);
      } else if (r->addend < 0) {
        wr("-");
        wru((unsigned)(-r->addend));
      }
      wr("\n");
      i += 4;
      continue;
    }
    int end = next_reloc_offset(rel, i, len);
    for (int j = i; j < end;) {
      wr("  .byte ");
      int k = 0;
      while (k < 16 && j < end) {
        if (k > 0)
          wr(",");
        wru((unsigned char)buf[j]);
        k++;
        j++;
      }
      wr("\n");
    }
    i = end;
  }
}

static void emit_data(Obj *prog) {
  bool wrote_section = false;
  for (Obj *var = prog; var; var = var->next) {
    if (var->is_function || !var->is_definition || !var->init_data)
      continue;
    if (!wrote_section) {
      wr(".data\n");
      wrote_section = true;
    }
    emit_label(var->name);
    int size = var->ty->size < 1 ? 1 : var->ty->size;
    emit_init_data(var->init_data, size, var->rel);
  }

  wrote_section = false;
  for (Obj *var = prog; var; var = var->next) {
    if (var->is_function || !var->is_definition || var->init_data)
      continue;
    if (!wrote_section) {
      wr(".bss\n");
      wrote_section = true;
    }
    emit_label(var->name);
    int size = var->ty->size < 1 ? 1 : var->ty->size;
    wr("  .space ");
    wru((unsigned)size);
    wr("\n");
  }
}

void codegen(Obj *prog, FILE *out) {
  output_file = out;

  for (Obj *fn = prog; fn; fn = fn->next)
    if (fn->is_function && fn->is_definition)
      assign_lvar_offsets(fn);

  for (Obj *o = prog; o; o = o->next) {
    if (!o->is_definition || o->is_static)
      continue;
    wr(".global ");
    wr(o->name);
    wr("\n");
  }

  wr(".text\n");
  for (Obj *fn = prog; fn; fn = fn->next)
    if (fn->is_function && fn->is_definition)
      gen_function(fn);

  emit_data(prog);
}

int align_to(int n, int align) { return (n + align - 1) / align * align; }
