#ifndef JSCPU_GUESTLINK_H
#define JSCPU_GUESTLINK_H

void assemble_and_link_guest(char *assembly, char *output_path);

// Assemble one translation unit's assembly text into a relocatable `.o` object
// file. Shared by `cc -c` and the standalone `as`.
void assemble_to_object(char *assembly, char *output_path);

// Link several inputs (each a `.s` assembly source or a `.o` object, plus a crt
// and the runtime/libc) into a single guest executable. Each input is assembled
// or loaded into its own image so translation-unit-local labels never collide;
// only `.global` symbols are resolved across inputs. Shared by `cc` link mode
// and the standalone `ld`.
void link_guest_objects(char **input_paths, int input_count, char *output_path);

// Read an entire file into a freshly allocated NUL-terminated buffer. Aborts on
// error. Exposed so the driver can expand `@listfile` response files.
char *guest_read_file(char *path);

// Like guest_read_file, but also reports the byte length (objects are binary and
// may contain NULs, so callers cannot rely on strlen).
char *guest_read_file_len(char *path, int *out_len);

#endif
