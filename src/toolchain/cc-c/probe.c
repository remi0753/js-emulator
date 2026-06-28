#include "chibicc.h"

// Phase 34 de-risking probe: prove the vendored chibicc frontend cross-compiles
// to custom32 and runs in the guest. Tokenize an in-memory source string with
// the real chibicc tokenizer and report what it produced. No file I/O, no
// codegen yet — this validates the frontend + guest libc + 64-bit climb before
// the codegen.c port is worth writing.

int main(void) {
  char *src = "int main(void) { return 1 + 2 * 3; }";
  File *file = new_file("probe.c", 1, src);
  Token *tok = tokenize(file);

  int count = 0;
  int idents = 0;
  int nums = 0;
  int puncts = 0;
  for (Token *t = tok; t && t->kind != TK_EOF; t = t->next) {
    count++;
    if (t->kind == TK_IDENT) idents++;
    else if (t->kind == TK_NUM || t->kind == TK_PP_NUM) nums++;
    else if (t->kind == TK_PUNCT) puncts++;
  }

  printf("probe tokens=%d ident=%d num=%d punct=%d\n", count, idents, nums, puncts);
  return 0;
}
