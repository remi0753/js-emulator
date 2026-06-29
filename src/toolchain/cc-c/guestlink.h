#ifndef JSCPU_GUESTLINK_H
#define JSCPU_GUESTLINK_H

void assemble_and_link_guest(char *assembly, char *output_path);

// Link several assembly inputs (one per translation unit, plus a crt and the
// runtime/libc assembly) into a single guest executable. Each input is
// assembled into its own image so translation-unit-local labels never collide;
// only `.global` symbols are resolved across inputs.
void link_guest_objects(char **input_paths, int input_count, char *output_path);

// Read an entire file into a freshly allocated NUL-terminated buffer. Aborts on
// error. Exposed so the driver can expand `@listfile` response files.
char *guest_read_file(char *path);

#endif
