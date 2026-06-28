#ifndef JSCPU_CC_STDARG_H
#define JSCPU_CC_STDARG_H

typedef char *va_list;

#define va_start(ap, last) ((ap) = (char *)&(last))
#define va_arg(ap, ty) (*(ty *)((ap) -= (((int)sizeof(ty) + 3) & ~3)))
#define va_end(ap) ((void)0)

#endif
