#include "upstream/chibicc.h"
#include "guestlink.h"

#define SEC_TEXT 1
#define SEC_DATA 2
#define SEC_BSS 3

#define ARG_NONE 0
#define ARG_REG 1
#define ARG_IMM 2
#define ARG_ADDR 3

typedef struct {
  char *name;
  int opcode;
  int argc;
  int a0;
  int a1;
} InsnSpec;

typedef struct {
  char *name;
  int section;
  int offset;
  int global;
} Symbol;

typedef struct {
  int section;
  int offset;
  char *name;
  int addend;
} Reloc;

typedef struct {
  unsigned char *data;
  int len;
  int cap;
} Bytes;

typedef struct {
  Bytes text;
  Bytes data;
  int bss_size;
  int section;
  Symbol *symbols;
  int symbol_count;
  int symbol_cap;
  Reloc *relocs;
  int reloc_count;
  int reloc_cap;
} AsmImage;

static InsnSpec specs[] = {
  {"NOP", 0x00, 0, ARG_NONE, ARG_NONE},
  {"MOV", 0x01, 2, ARG_REG, ARG_IMM},
  {"MOVR", 0x02, 2, ARG_REG, ARG_REG},
  {"LOAD", 0x03, 2, ARG_REG, ARG_ADDR},
  {"STORE", 0x04, 2, ARG_REG, ARG_ADDR},
  {"LOADR", 0x05, 2, ARG_REG, ARG_REG},
  {"STORER", 0x06, 2, ARG_REG, ARG_REG},
  {"LB", 0x07, 2, ARG_REG, ARG_REG},
  {"SB", 0x08, 2, ARG_REG, ARG_REG},
  {"LBS", 0x09, 2, ARG_REG, ARG_REG},
  {"LH", 0x0a, 2, ARG_REG, ARG_REG},
  {"LHS", 0x0b, 2, ARG_REG, ARG_REG},
  {"SH", 0x0c, 2, ARG_REG, ARG_REG},
  {"ADD", 0x10, 2, ARG_REG, ARG_REG},
  {"SUB", 0x11, 2, ARG_REG, ARG_REG},
  {"MUL", 0x12, 2, ARG_REG, ARG_REG},
  {"DIV", 0x13, 2, ARG_REG, ARG_REG},
  {"MOD", 0x14, 2, ARG_REG, ARG_REG},
  {"AND", 0x15, 2, ARG_REG, ARG_REG},
  {"OR", 0x16, 2, ARG_REG, ARG_REG},
  {"XOR", 0x17, 2, ARG_REG, ARG_REG},
  {"NOT", 0x18, 1, ARG_REG, ARG_NONE},
  {"SHL", 0x19, 2, ARG_REG, ARG_REG},
  {"SHR", 0x1a, 2, ARG_REG, ARG_REG},
  {"INC", 0x1b, 1, ARG_REG, ARG_NONE},
  {"DEC", 0x1c, 1, ARG_REG, ARG_NONE},
  {"CMP", 0x1d, 2, ARG_REG, ARG_REG},
  {"IDIV", 0x1e, 2, ARG_REG, ARG_REG},
  {"IMOD", 0x1f, 2, ARG_REG, ARG_REG},
  {"JMP", 0x20, 1, ARG_ADDR, ARG_NONE},
  {"JZ", 0x21, 1, ARG_ADDR, ARG_NONE},
  {"JNZ", 0x22, 1, ARG_ADDR, ARG_NONE},
  {"JG", 0x23, 1, ARG_ADDR, ARG_NONE},
  {"JGE", 0x24, 1, ARG_ADDR, ARG_NONE},
  {"JL", 0x25, 1, ARG_ADDR, ARG_NONE},
  {"JLE", 0x26, 1, ARG_ADDR, ARG_NONE},
  {"CALL", 0x27, 1, ARG_ADDR, ARG_NONE},
  {"RET", 0x28, 0, ARG_NONE, ARG_NONE},
  {"CALLR", 0x29, 1, ARG_REG, ARG_NONE},
  {"JA", 0x2a, 1, ARG_ADDR, ARG_NONE},
  {"JAE", 0x2b, 1, ARG_ADDR, ARG_NONE},
  {"JB", 0x2c, 1, ARG_ADDR, ARG_NONE},
  {"JBE", 0x2d, 1, ARG_ADDR, ARG_NONE},
  {"SAR", 0x2e, 2, ARG_REG, ARG_REG},
  {"PUSH", 0x30, 1, ARG_REG, ARG_NONE},
  {"POP", 0x31, 1, ARG_REG, ARG_NONE},
  {"INT", 0x40, 1, ARG_IMM, ARG_NONE},
  {"EI", 0x41, 0, ARG_NONE, ARG_NONE},
  {"DI", 0x42, 0, ARG_NONE, ARG_NONE},
  {"IN", 0x43, 2, ARG_REG, ARG_REG},
  {"OUT", 0x44, 2, ARG_REG, ARG_REG},
  {"IRET", 0x45, 0, ARG_NONE, ARG_NONE},
  {"LIDT", 0x46, 1, ARG_REG, ARG_NONE},
  {"LKSP", 0x47, 1, ARG_REG, ARG_NONE},
  {"RDPFLA", 0x48, 1, ARG_REG, ARG_NONE},
  {"RDERR", 0x49, 1, ARG_REG, ARG_NONE},
  {"STMR", 0x4a, 1, ARG_REG, ARG_NONE},
  {"LPTBR", 0x4b, 1, ARG_REG, ARG_NONE},
  {"PGON", 0x4c, 0, ARG_NONE, ARG_NONE},
  {"PGOFF", 0x4d, 0, ARG_NONE, ARG_NONE},
  {"HLT", 0xff, 0, ARG_NONE, ARG_NONE},
};

static char *guest_crt =
".global _start\n"
".global memcpy, memset, strlen, strcmp, __syscall\n"
".global write, read, open, close, exit\n"
".global __csp, __stack, environ\n"
".text\n"
"_start:\n"
"  MOV R5, __stack\n"
"  STORE R5, __csp\n"
"  STORE R2, environ\n"
"  LOAD R5, __csp\n"
"  STORER R5, R1\n"
"  MOV R7, 4\n"
"  ADD R5, R7\n"
"  STORE R5, __csp\n"
"  LOAD R5, __csp\n"
"  STORER R5, R0\n"
"  MOV R7, 4\n"
"  ADD R5, R7\n"
"  STORE R5, __csp\n"
"  CALL main\n"
"  LOAD R5, __csp\n"
"  MOV R7, 8\n"
"  SUB R5, R7\n"
"  STORE R5, __csp\n"
"  MOVR R1, R0\n"
"  MOV R0, 0\n"
"  INT 128\n"
"__arg1:\n"
"  MOVR R5, R6\n"
"  MOV R7, 4\n"
"  SUB R5, R7\n"
"  LOADR R0, R5\n"
"  RET\n"
"__arg2:\n"
"  MOVR R5, R6\n"
"  MOV R7, 8\n"
"  SUB R5, R7\n"
"  LOADR R0, R5\n"
"  RET\n"
"__arg3:\n"
"  MOVR R5, R6\n"
"  MOV R7, 12\n"
"  SUB R5, R7\n"
"  LOADR R0, R5\n"
"  RET\n"
"__arg4:\n"
"  MOVR R5, R6\n"
"  MOV R7, 16\n"
"  SUB R5, R7\n"
"  LOADR R0, R5\n"
"  RET\n"
"__syscall:\n"
"  PUSH R6\n"
"  LOAD R6, __csp\n"
"  CALL __arg1\n"
"  MOVR R4, R0\n"
"  CALL __arg2\n"
"  MOVR R1, R0\n"
"  CALL __arg3\n"
"  MOVR R2, R0\n"
"  CALL __arg4\n"
"  MOVR R3, R0\n"
"  MOVR R0, R4\n"
"  INT 128\n"
"  STORE R6, __csp\n"
"  POP R6\n"
"  RET\n"
"write:\n"
"  PUSH R6\n"
"  LOAD R6, __csp\n"
"  CALL __arg1\n"
"  MOVR R1, R0\n"
"  CALL __arg2\n"
"  MOVR R2, R0\n"
"  CALL __arg3\n"
"  MOVR R3, R0\n"
"  MOV R0, 1\n"
"  INT 128\n"
"  STORE R6, __csp\n"
"  POP R6\n"
"  RET\n"
"read:\n"
"  PUSH R6\n"
"  LOAD R6, __csp\n"
"  CALL __arg1\n"
"  MOVR R1, R0\n"
"  CALL __arg2\n"
"  MOVR R2, R0\n"
"  CALL __arg3\n"
"  MOVR R3, R0\n"
"  MOV R0, 9\n"
"  INT 128\n"
"  STORE R6, __csp\n"
"  POP R6\n"
"  RET\n"
"open:\n"
"  PUSH R6\n"
"  LOAD R6, __csp\n"
"  CALL __arg1\n"
"  MOVR R1, R0\n"
"  CALL __arg2\n"
"  MOVR R2, R0\n"
"  MOV R3, 0\n"
"  MOV R0, 7\n"
"  INT 128\n"
"  STORE R6, __csp\n"
"  POP R6\n"
"  RET\n"
"close:\n"
"  PUSH R6\n"
"  LOAD R6, __csp\n"
"  CALL __arg1\n"
"  MOVR R1, R0\n"
"  MOV R0, 8\n"
"  INT 128\n"
"  STORE R6, __csp\n"
"  POP R6\n"
"  RET\n"
"exit:\n"
"  PUSH R6\n"
"  LOAD R6, __csp\n"
"  CALL __arg1\n"
"  MOVR R1, R0\n"
"  MOV R0, 0\n"
"  INT 128\n"
"  STORE R6, __csp\n"
"  POP R6\n"
"  RET\n"
"memcpy:\n"
"  PUSH R6\n"
"  LOAD R6, __csp\n"
"  MOVR R1, R6\n"
"  MOV R7, 4\n"
"  SUB R1, R7\n"
"  LOADR R2, R1\n"
"  MOVR R1, R6\n"
"  MOV R7, 8\n"
"  SUB R1, R7\n"
"  LOADR R3, R1\n"
"  MOVR R1, R6\n"
"  MOV R7, 12\n"
"  SUB R1, R7\n"
"  LOADR R4, R1\n"
"  MOVR R0, R2\n"
"memcpy_loop:\n"
"  MOV R7, 0\n"
"  CMP R4, R7\n"
"  JZ memcpy_done\n"
"  LB R5, R3\n"
"  SB R2, R5\n"
"  INC R2\n"
"  INC R3\n"
"  DEC R4\n"
"  JMP memcpy_loop\n"
"memcpy_done:\n"
"  STORE R6, __csp\n"
"  POP R6\n"
"  RET\n"
"memset:\n"
"  PUSH R6\n"
"  LOAD R6, __csp\n"
"  MOVR R1, R6\n"
"  MOV R7, 4\n"
"  SUB R1, R7\n"
"  LOADR R2, R1\n"
"  MOVR R1, R6\n"
"  MOV R7, 8\n"
"  SUB R1, R7\n"
"  LOADR R3, R1\n"
"  MOVR R1, R6\n"
"  MOV R7, 12\n"
"  SUB R1, R7\n"
"  LOADR R4, R1\n"
"  MOVR R0, R2\n"
"memset_loop:\n"
"  MOV R7, 0\n"
"  CMP R4, R7\n"
"  JZ memset_done\n"
"  SB R2, R3\n"
"  INC R2\n"
"  DEC R4\n"
"  JMP memset_loop\n"
"memset_done:\n"
"  STORE R6, __csp\n"
"  POP R6\n"
"  RET\n"
"strlen:\n"
"  PUSH R6\n"
"  LOAD R6, __csp\n"
"  CALL __arg1\n"
"  MOVR R2, R0\n"
"  MOV R0, 0\n"
"strlen_loop:\n"
"  LB R3, R2\n"
"  MOV R7, 0\n"
"  CMP R3, R7\n"
"  JZ strlen_done\n"
"  INC R0\n"
"  INC R2\n"
"  JMP strlen_loop\n"
"strlen_done:\n"
"  STORE R6, __csp\n"
"  POP R6\n"
"  RET\n"
"strcmp:\n"
"  PUSH R6\n"
"  LOAD R6, __csp\n"
"  CALL __arg1\n"
"  MOVR R2, R0\n"
"  CALL __arg2\n"
"  MOVR R3, R0\n"
"strcmp_loop:\n"
"  LB R4, R2\n"
"  LB R5, R3\n"
"  CMP R4, R5\n"
"  JNZ strcmp_diff\n"
"  MOV R7, 0\n"
"  CMP R4, R7\n"
"  JZ strcmp_eq\n"
"  INC R2\n"
"  INC R3\n"
"  JMP strcmp_loop\n"
"strcmp_diff:\n"
"  MOVR R0, R4\n"
"  SUB R0, R5\n"
"  JMP strcmp_done\n"
"strcmp_eq:\n"
"  MOV R0, 0\n"
"strcmp_done:\n"
"  STORE R6, __csp\n"
"  POP R6\n"
"  RET\n"
".data\n"
"__csp:\n"
"  .word 0\n"
"environ:\n"
"  .word 0\n"
".bss\n"
"__stack:\n"
"  .space 16384\n";

static void die(char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  fprintf(stderr, "cc: ");
  vfprintf(stderr, fmt, ap);
  fprintf(stderr, "\n");
  va_end(ap);
  exit(1);
}

static int align_to_guest(int n, int align) {
  return (n + align - 1) / align * align;
}

static void write32(unsigned char *p, unsigned int v) {
  p[0] = v & 255;
  p[1] = (v >> 8) & 255;
  p[2] = (v >> 16) & 255;
  p[3] = (v >> 24) & 255;
}

static void bytes_push(Bytes *b, int value) {
  if (b->len >= b->cap) {
    b->cap = b->cap ? b->cap * 2 : 256;
    b->data = realloc(b->data, b->cap);
  }
  b->data[b->len++] = value & 255;
}

static void bytes_zero(Bytes *b, int count) {
  while (count-- > 0) bytes_push(b, 0);
}

static int current_offset(AsmImage *img) {
  if (img->section == SEC_TEXT) return img->text.len;
  if (img->section == SEC_DATA) return img->data.len;
  return img->bss_size;
}

static void emit_byte(AsmImage *img, int value) {
  if (img->section == SEC_BSS) die("cannot emit bytes in .bss");
  bytes_push(img->section == SEC_TEXT ? &img->text : &img->data, value);
}

static void emit_word_raw(AsmImage *img, unsigned int value) {
  emit_byte(img, value);
  emit_byte(img, value >> 8);
  emit_byte(img, value >> 16);
  emit_byte(img, value >> 24);
}

static void reserve_bytes(AsmImage *img, int count) {
  if (count < 0) die("negative .space");
  if (img->section == SEC_BSS) img->bss_size += count;
  else bytes_zero(img->section == SEC_TEXT ? &img->text : &img->data, count);
}

static char *skip_ws(char *p) {
  while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
  return p;
}

static void rtrim(char *s) {
  int n = strlen(s);
  while (n > 0 && (s[n - 1] == ' ' || s[n - 1] == '\t' || s[n - 1] == '\r' || s[n - 1] == '\n'))
    s[--n] = 0;
}

static int name_start(int c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_' || c == '.';
}

static int name_char(int c) {
  return name_start(c) || (c >= '0' && c <= '9');
}

static char *dup_range(char *start, int len) {
  char *out = malloc(len + 1);
  memcpy(out, start, len);
  out[len] = 0;
  return out;
}

static void strip_comment(char *line) {
  int in_str = 0;
  for (int i = 0; line[i]; i++) {
    if (line[i] == '"' && (i == 0 || line[i - 1] != '\\')) in_str = !in_str;
    if (!in_str && (line[i] == ';' || line[i] == '#')) {
      line[i] = 0;
      return;
    }
  }
}

static int find_symbol(AsmImage *img, char *name) {
  for (int i = 0; i < img->symbol_count; i++)
    if (!strcmp(img->symbols[i].name, name)) return i;
  return -1;
}

static Symbol *ensure_symbol(AsmImage *img, char *name) {
  int i = find_symbol(img, name);
  if (i >= 0) return &img->symbols[i];
  if (img->symbol_count >= img->symbol_cap) {
    img->symbol_cap = img->symbol_cap ? img->symbol_cap * 2 : 128;
    img->symbols = realloc(img->symbols, img->symbol_cap * sizeof(Symbol));
  }
  Symbol *sym = &img->symbols[img->symbol_count++];
  sym->name = strdup(name);
  sym->section = 0;
  sym->offset = 0;
  sym->global = 0;
  return sym;
}

static void define_symbol(AsmImage *img, char *name) {
  Symbol *sym = ensure_symbol(img, name);
  if (sym->section != 0) die("duplicate label: %s", name);
  sym->section = img->section;
  sym->offset = current_offset(img);
}

static void mark_global(AsmImage *img, char *name) {
  ensure_symbol(img, name)->global = 1;
}

static void add_reloc(AsmImage *img, int section, int offset, char *name, int addend) {
  if (img->reloc_count >= img->reloc_cap) {
    img->reloc_cap = img->reloc_cap ? img->reloc_cap * 2 : 128;
    img->relocs = realloc(img->relocs, img->reloc_cap * sizeof(Reloc));
  }
  Reloc *rel = &img->relocs[img->reloc_count++];
  rel->section = section;
  rel->offset = offset;
  rel->name = strdup(name);
  rel->addend = addend;
  ensure_symbol(img, name);
}

static int parse_uint(char *s, unsigned int *out) {
  char *end;
  unsigned int value;
  s = skip_ws(s);
  if (*s == 0) return 0;
  value = strtoul(s, &end, 0);
  end = skip_ws(end);
  if (*end != 0) return 0;
  *out = value;
  return 1;
}

static int parse_reg(char *s) {
  s = skip_ws(s);
  if ((s[0] != 'R' && s[0] != 'r') || s[1] < '0' || s[1] > '7') die("bad register: %s", s);
  if (skip_ws(s + 2)[0] != 0) die("bad register: %s", s);
  return s[1] - '0';
}

static void parse_symbol_ref(char *s, char **name, int *addend) {
  char *p;
  s = skip_ws(s);
  if (!name_start(*s)) die("bad symbol reference: %s", s);
  p = s;
  while (name_char(*p)) p++;
  *name = dup_range(s, p - s);
  p = skip_ws(p);
  *addend = 0;
  if (*p == '+' || *p == '-') {
    int sign = *p == '-' ? -1 : 1;
    unsigned int n;
    p = skip_ws(p + 1);
    if (!parse_uint(p, &n)) die("bad symbol addend: %s", s);
    *addend = sign * (int)n;
    return;
  }
  if (*p != 0) die("bad symbol reference: %s", s);
}

static void emit_value(AsmImage *img, char *operand) {
  unsigned int value;
  if (parse_uint(operand, &value)) {
    emit_word_raw(img, value);
    return;
  }
  if (img->section == SEC_BSS) die("relocation in .bss");
  char *name;
  int addend;
  parse_symbol_ref(operand, &name, &addend);
  add_reloc(img, img->section, current_offset(img), name, addend);
  emit_word_raw(img, 0);
}

static int split_operands(char *s, char **out, int max) {
  int n = 0;
  int in_str = 0;
  char *start = s;
  for (char *p = s; ; p++) {
    if (*p == '"' && (p == s || p[-1] != '\\')) in_str = !in_str;
    if ((*p == ',' && !in_str) || *p == 0) {
      int done = *p == 0;
      if (n >= max) die("too many operands");
      *p = 0;
      out[n++] = skip_ws(start);
      rtrim(out[n - 1]);
      if (done) break;
      start = p + 1;
    }
  }
  if (n == 1 && out[0][0] == 0) return 0;
  return n;
}

static InsnSpec *find_spec(char *name) {
  int count = sizeof(specs) / sizeof(specs[0]);
  for (int i = 0; i < count; i++)
    if (!strcmp(specs[i].name, name)) return &specs[i];
  return 0;
}

static void uppercase(char *s) {
  for (int i = 0; s[i]; i++)
    if (s[i] >= 'a' && s[i] <= 'z') s[i] = s[i] - 32;
}

static void parse_global(AsmImage *img, char *rest) {
  char *ops[64];
  int n = split_operands(rest, ops, 64);
  for (int i = 0; i < n; i++) mark_global(img, ops[i]);
}

static void parse_byte_directive(AsmImage *img, char *rest) {
  char *ops[128];
  int n = split_operands(rest, ops, 128);
  for (int i = 0; i < n; i++) {
    unsigned int value;
    if (!parse_uint(ops[i], &value)) die(".byte requires a constant: %s", ops[i]);
    emit_byte(img, value);
  }
}

static void parse_word_directive(AsmImage *img, char *rest) {
  char *ops[64];
  int n = split_operands(rest, ops, 64);
  for (int i = 0; i < n; i++) emit_value(img, ops[i]);
}

static void parse_line(AsmImage *img, char *line) {
  char *p;
  char *head;
  char *rest;
  int head_len;
  strip_comment(line);
  rtrim(line);
  p = skip_ws(line);
  if (*p == 0) return;

  while (name_start(*p)) {
    char *q = p;
    while (name_char(*q)) q++;
    if (*skip_ws(q) != ':') break;
    define_symbol(img, dup_range(p, q - p));
    p = skip_ws(skip_ws(q) + 1);
    if (*p == 0) return;
  }

  head = p;
  while (*p && *p != ' ' && *p != '\t') p++;
  head_len = p - head;
  rest = skip_ws(p);
  head = dup_range(head, head_len);
  uppercase(head);

  if (!strcmp(head, ".TEXT")) {
    img->section = SEC_TEXT;
    return;
  }
  if (!strcmp(head, ".DATA")) {
    img->section = SEC_DATA;
    return;
  }
  if (!strcmp(head, ".BSS")) {
    img->section = SEC_BSS;
    return;
  }
  if (!strcmp(head, ".GLOBAL") || !strcmp(head, ".GLOBL")) {
    parse_global(img, rest);
    return;
  }
  if (!strcmp(head, ".BYTE")) {
    parse_byte_directive(img, rest);
    return;
  }
  if (!strcmp(head, ".WORD")) {
    parse_word_directive(img, rest);
    return;
  }
  if (!strcmp(head, ".SPACE") || !strcmp(head, ".ZERO")) {
    unsigned int n;
    if (!parse_uint(rest, &n)) die("%s requires a constant", head);
    reserve_bytes(img, n);
    return;
  }

  if (img->section != SEC_TEXT) die("instruction outside .text: %s", head);
  InsnSpec *spec = find_spec(head);
  if (!spec) die("unknown instruction: %s", head);
  char *ops[4];
  int n = split_operands(rest, ops, 4);
  if (n != spec->argc) die("%s expects %d operand(s), got %d", head, spec->argc, n);
  emit_byte(img, spec->opcode);
  int kinds[2];
  kinds[0] = spec->a0;
  kinds[1] = spec->a1;
  for (int i = 0; i < n; i++) {
    if (kinds[i] == ARG_REG) emit_byte(img, parse_reg(ops[i]));
    else emit_value(img, ops[i]);
  }
}

static void assemble_source(AsmImage *img, char *source) {
  char *line = source;
  while (*line) {
    char *next = strchr(line, '\n');
    if (next) *next = 0;
    parse_line(img, line);
    if (!next) break;
    line = next + 1;
  }
}

static int symbol_addr(AsmImage *img, Symbol *sym, int text_base, int data_base, int bss_base) {
  if (sym->section == SEC_TEXT) return text_base + sym->offset;
  if (sym->section == SEC_DATA) return data_base + sym->offset;
  if (sym->section == SEC_BSS) return bss_base + sym->offset;
  die("undefined symbol: %s", sym->name);
  return 0;
}

static void patch_relocs(AsmImage *img, int text_base, int data_base, int bss_base) {
  for (int i = 0; i < img->reloc_count; i++) {
    Reloc *rel = &img->relocs[i];
    int si = find_symbol(img, rel->name);
    if (si < 0) die("undefined symbol: %s", rel->name);
    int value = symbol_addr(img, &img->symbols[si], text_base, data_base, bss_base) + rel->addend;
    if (rel->section == SEC_TEXT) {
      if (rel->offset + 4 > img->text.len) die("bad text relocation");
      write32(img->text.data + rel->offset, value);
    } else {
      if (rel->offset + 4 > img->data.len) die("bad data relocation");
      write32(img->data.data + rel->offset, value);
    }
  }
}

static void write_executable(AsmImage *img, char *output_path) {
  int text_base = CFG_USER_LOAD_BASE;
  int text_end = text_base + img->text.len;
  int data_base = align_to_guest(text_end, 4096);
  int data_end = data_base + img->data.len;
  int bss_base = align_to_guest(data_end, 4);
  int mem_end = bss_base + img->bss_size;
  int file_len = data_end - text_base;
  int entry_index = find_symbol(img, "_start");
  int entry;
  unsigned char *out;
  FILE *f;

  if (entry_index < 0) die("entry symbol not found: _start");
  entry = symbol_addr(img, &img->symbols[entry_index], text_base, data_base, bss_base);
  patch_relocs(img, text_base, data_base, bss_base);

  out = calloc(12 + file_len, 1);
  write32(out, CFG_EXEC_MAGIC);
  write32(out + 4, entry);
  write32(out + 8, mem_end - text_base);
  memcpy(out + 12, img->text.data, img->text.len);
  memcpy(out + 12 + (data_base - text_base), img->data.data, img->data.len);

  f = fopen(output_path, "w");
  if (!f) die("cannot open %s: %s", output_path, strerror(errno));
  if (fwrite(out, 1, 12 + file_len, f) != 12 + file_len) die("cannot write %s", output_path);
  fclose(f);
  chmod(output_path, 493);
}

// --- multi-input linker -----------------------------------------------------

typedef struct {
  char *name;
  int addr;
} GlobalSym;

char *guest_read_file(char *path) {
  int fd = open(path, 0);
  if (fd < 0) die("cannot open %s: %s", path, strerror(errno));
  int cap = 8192;
  int len = 0;
  char *buf = malloc(cap);
  if (buf == 0) die("out of memory reading %s", path);
  for (;;) {
    if (len + 4096 > cap) {
      cap = cap * 2;
      buf = realloc(buf, cap);
      if (buf == 0) die("out of memory reading %s", path);
    }
    int n = read(fd, buf + len, 4096);
    if (n < 0) die("cannot read %s: %s", path, strerror(errno));
    if (n == 0) break;
    len = len + n;
  }
  if (len + 1 > cap) buf = realloc(buf, len + 1);
  if (buf == 0) die("out of memory reading %s", path);
  buf[len] = 0;
  close(fd);
  return buf;
}

void link_guest_objects(char **input_paths, int input_count, char *output_path) {
  AsmImage *imgs = calloc(input_count, sizeof(AsmImage));
  for (int i = 0; i < input_count; i++) {
    char *source = guest_read_file(input_paths[i]);
    memset(&imgs[i], 0, sizeof(AsmImage));
    imgs[i].section = SEC_TEXT;
    assemble_source(&imgs[i], source);
  }

  // Lay out every image's text, then every image's data, then bss.
  int *tb = calloc(input_count, sizeof(int));
  int *db = calloc(input_count, sizeof(int));
  int *bb = calloc(input_count, sizeof(int));
  int text_base = CFG_USER_LOAD_BASE;
  int cur = text_base;
  for (int i = 0; i < input_count; i++) {
    tb[i] = cur;
    cur = cur + imgs[i].text.len;
  }
  int text_end = cur;
  int data_base = align_to_guest(text_end, 4096);
  cur = data_base;
  for (int i = 0; i < input_count; i++) {
    db[i] = cur;
    cur = cur + imgs[i].data.len;
  }
  int data_end = cur;
  int bss_base = align_to_guest(data_end, 4);
  cur = bss_base;
  for (int i = 0; i < input_count; i++) {
    bb[i] = cur;
    cur = cur + imgs[i].bss_size;
  }
  int mem_end = cur;

  // Collect every defined global symbol with its absolute address.
  int gcount = 0;
  int gcap = 256;
  GlobalSym *globals = malloc(gcap * sizeof(GlobalSym));
  for (int i = 0; i < input_count; i++) {
    for (int s = 0; s < imgs[i].symbol_count; s++) {
      Symbol *sym = &imgs[i].symbols[s];
      if (!sym->global || sym->section == 0) continue;
      for (int g = 0; g < gcount; g++)
        if (!strcmp(globals[g].name, sym->name)) die("duplicate global symbol: %s", sym->name);
      if (gcount >= gcap) {
        gcap = gcap * 2;
        globals = realloc(globals, gcap * sizeof(GlobalSym));
      }
      globals[gcount].name = sym->name;
      globals[gcount].addr = symbol_addr(&imgs[i], sym, tb[i], db[i], bb[i]);
      gcount = gcount + 1;
    }
  }

  // Resolve relocations: a symbol defined in the same image is local; anything
  // else must be a global exported by another input.
  for (int i = 0; i < input_count; i++) {
    AsmImage *img = &imgs[i];
    for (int r = 0; r < img->reloc_count; r++) {
      Reloc *rel = &img->relocs[r];
      int value;
      int si = find_symbol(img, rel->name);
      if (si >= 0 && img->symbols[si].section != 0) {
        value = symbol_addr(img, &img->symbols[si], tb[i], db[i], bb[i]);
      } else {
        int g = 0;
        for (; g < gcount; g++)
          if (!strcmp(globals[g].name, rel->name)) break;
        if (g == gcount) die("undefined symbol: %s", rel->name);
        value = globals[g].addr;
      }
      value = value + rel->addend;
      if (rel->section == SEC_TEXT) {
        if (rel->offset + 4 > img->text.len) die("bad text relocation");
        write32(img->text.data + rel->offset, value);
      } else {
        if (rel->offset + 4 > img->data.len) die("bad data relocation");
        write32(img->data.data + rel->offset, value);
      }
    }
  }

  int entry = -1;
  for (int g = 0; g < gcount; g++)
    if (!strcmp(globals[g].name, "_start")) entry = globals[g].addr;
  if (entry < 0) die("entry symbol not found: _start");

  int file_len = data_end - text_base;
  unsigned char *out = calloc(12 + file_len, 1);
  write32(out, CFG_EXEC_MAGIC);
  write32(out + 4, entry);
  write32(out + 8, mem_end - text_base);
  for (int i = 0; i < input_count; i++) {
    if (imgs[i].text.len) memcpy(out + 12 + (tb[i] - text_base), imgs[i].text.data, imgs[i].text.len);
    if (imgs[i].data.len) memcpy(out + 12 + (db[i] - text_base), imgs[i].data.data, imgs[i].data.len);
  }

  FILE *f = fopen(output_path, "w");
  if (!f) die("cannot open %s: %s", output_path, strerror(errno));
  if (fwrite(out, 1, 12 + file_len, f) != 12 + file_len) die("cannot write %s", output_path);
  fclose(f);
  chmod(output_path, 493);
}

void assemble_and_link_guest(char *assembly, char *output_path) {
  AsmImage img;
  char *combined = calloc(strlen(guest_crt) + strlen(assembly) + 2, 1);
  memset(&img, 0, sizeof(img));
  img.section = SEC_TEXT;
  strcpy(combined, guest_crt);
  strcat(combined, "\n");
  strcat(combined, assembly);
  assemble_source(&img, combined);
  write_executable(&img, output_path);
}
