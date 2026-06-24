// Shared declarations for the guest kernel.
//
// Every kernel .c file includes this header (via the toolchain's #include
// preprocessor, src/toolchain/preprocess.ts). It declares the cross-subsystem
// globals as `extern` and prototypes the functions each subsystem exposes, so
// the files can be compiled separately and linked into one image without
// duplicating declarations.
//
// CFG_* tokens are substituted by ../guest-kernel.ts (the single source of
// truth for the memory layout, ISA constants, syscall numbers, ports, and FS
// format). The editor sees them via src/v3/generated-config.h.
#ifndef JSCPU_OS_KERNEL_H
#define JSCPU_OS_KERNEL_H

// --- shared kernel object model ---
//
// Keep related state together. New process, VM, file, vnode, and pipe fields
// belong in these structures rather than in parallel global arrays.
struct cpu_context {
  int regs[8];
  int pc;
  int sp;
  int flags;
  int mode;
};

struct vm_space {
  int ptbr;
};

typedef int (*file_io_fn)(int file, int caller, int buf, int len);
typedef void (*file_lifecycle_fn)(int file);

struct file_ops {
  file_io_fn read;
  file_io_fn write;
  file_lifecycle_fn close;
  file_lifecycle_fn retain;
};

struct inode {
  int inum;
  int type;
  int size;
};

struct vnode {
  struct inode inode;
};

// A descriptor points at an open-file object. The latter owns the shared file
// offset and reference count, so dup() and fork() preserve Unix open-file
// description semantics instead of copying the offset by value.
struct open_file {
  int used;
  int refs;
  int offset;
  struct vnode vnode;
};

struct file {
  struct file_ops *ops;
  int type;
  int readable;
  int writable;
  int pipe_end;
  int object;
};

struct proc {
  int state;
  int parent;
  int exit_code;
  int chan;
  struct vm_space vm;
  struct cpu_context ctx;
  struct file files[CFG_NFD];
};

struct pipe {
  int used;
  int count;
  int head;
  int nread;
  int nwrite;
  char data[CFG_PIPESZ];
};

// --- scheduler.c ---
extern int ticks;
extern int current;
void save_ctx(int i);
void load_ctx(int i);
int schedule(void);
void switch_to_next(void);
void on_timer(void);
// Wait-channel primitive: sleep(idx, chan) blocks process idx on `chan` and
// switches away; wakeup(chan) makes every process sleeping on `chan` runnable.
// Channels are object addresses (e.g. a pipe or process object), so
// distinct objects never collide.
void sleep(int idx, int chan);
void wakeup(int chan);

// --- process.c ---
extern int nproc;
extern struct proc proc_table[CFG_MAX_PROC];
int alloc_proc(void);
int fork_process(int parent);
int setup_process_boot(int path);
int do_fork(int parent);
int do_exit(int idx, int code);
int do_wait(int parent);

// --- memory.c ---
extern int free_list;
extern int kernel_pt;
void zero_page(int addr);
void copy_page(int src, int dst);
int read32_at(int addr);
int read16_at(int addr);
int read8_at(int addr);
void write32_at(int addr, int v);
void write8_at(int addr, int v);
int user_phys_addr(int proc, int addr, int write);
int user_access_ok(int proc, int addr, int len, int write);
// copyin/copyout are the normal path for moving bytes across the user/kernel
// boundary: they validate the user range in `proc`'s address space first, then
// copy. They return 0 on success and a negative errno on a bad address.
int copyin(int proc, int kdst, int usrc, int len);
int copyout(int proc, int udst, int ksrc, int len);
// Copy a NUL-terminated string in from user memory (bounded by `max`, including
// the terminator). Returns the string length on success, or a negative errno.
int copyinstr(int proc, int kdst, int usrc, int max);
void free_frame(int frame);
int alloc_frame(void);
int free_frame_count(void);
void pmm_init(void);
void build_kernel_pt(void);
int new_address_space(void);
void map_page(int pd, int vaddr, int frame, int flags);
void copy_space(int src, int dst);
void free_space(int pd);

// --- fs.c ---
extern int fs_size;
extern int fs_ninodes;
extern int fs_inodestart;
extern int fs_bmapstart;
extern int buf_block[CFG_NBUF];
extern int buf_valid[CFG_NBUF];
extern int buf_next;
extern char buf_data[CFG_BUF_DATA_LEN]; // NBUF * 512 bytes
extern char namebuf[16];                // one path component during namei
extern char direntbuf[16];              // one directory entry during dirlookup
int bread(int blockno);
void fs_mount(void);
int inode_addr(int inum);
int inode_type(int inum);
int inode_size(int inum);
int inode_slot(int inum, int k);
void vnode_init(struct vnode *node, int inum);
int bmap(int inum, int bn);
int readi(int inum, int off, int n, int dst);
int vnode_read(struct vnode *node, int off, int n, int dst);
int name_eq(int dname, int want, int wlen);
int dirlookup(int dir, int name, int namelen);
int namei(int path);

// --- file.c (per-process file descriptors) ---
extern struct file_ops console_file_ops;
extern struct file_ops keyboard_file_ops;
extern struct file_ops vnode_file_ops;
extern struct file_ops pipe_file_ops;
extern struct open_file open_file_table[CFG_NFILE];
void file_init(void);
void file_reset(struct file *file);
void file_set_console(struct file *file);
void file_set_keyboard(struct file *file);
int file_set_vnode(struct file *file, int inum);
void file_set_pipe(struct file *file, int pipe, int end);
int file_read(struct file *file, int caller, int buf, int len);
int file_write(struct file *file, int caller, int buf, int len);
void file_close(struct file *file);
void file_retain(struct file *file);
void copy_file(struct file *dst, struct file *src);
void init_fds(int idx);
int alloc_fd(int idx);
void fd_close(int idx, int fd);
void clear_fds(int idx);
void copy_fds(int dst, int src);

// --- pipe.c ---
extern struct pipe pipe_table[CFG_NPIPE];
int alloc_pipe(void);
int pipe_write_bytes(int pp, int buf, int len);
int pipe_read_bytes(int pp, int buf, int len);

// --- exec.c ---
extern char kpath[CFG_INITPATH_LEN]; // a path copied in from user memory
extern char exec_hdr[12];            // the executable header (magic, entry, memSize)
extern char argbuf[CFG_ARGBUF_LEN];  // packed NUL-terminated argv strings
extern int arg_off[CFG_MAXARG];      // start offset of each arg in argbuf
extern int g_argc;                   // argument count staged for the next spawn
int copy_path_in(int proc, int upath);
void build_args_single(int kstr);
int build_args_from_user(int proc, int uargv);
int load_exec_image(int pd, int path);
int setup_user_args(int idx, int pd);
int spawn(int idx, int path);
int do_exec(int idx, int upath, int uargv);

// --- syscall.c ---
extern int g_noret;        // set when a handler set R0 itself (don't overwrite it)
extern int g_pending_free; // address space to free after switching, or 0
// A syscall handler: h(caller, a1, a2, a3) -> value for R0. The table maps a
// syscall number to a handler (a null/zero slot is unimplemented).
typedef int (*syscall_fn)(int caller, int a1, int a2, int a3);
extern syscall_fn syscall_table[CFG_NSYS];
void syscall_init(void);
int sys_write(int caller, int fd, int buf, int len);
int sys_read(int caller, int fd, int buf, int len);
int sys_open(int caller, int upath, int flags);
int sys_close(int caller, int fd);
int sys_pipe(int caller, int ufds);
int sys_dup(int caller, int oldfd);
void on_syscall(void);

// --- trap.c ---
// Trap-frame scratch shared with the assembly trap/context-switch stubs.
extern int sctx_r0; extern int sctx_r1; extern int sctx_r2; extern int sctx_r3;
extern int sctx_r4; extern int sctx_r5; extern int sctx_r6; extern int sctx_r7;
extern int sctx_pc; extern int sctx_sp; extern int sctx_flags; extern int sctx_mode;
extern int page_fault_addr;
extern int default_handler_addr;
extern int timer_handler_addr;
extern int pf_handler_addr;
extern int syscall_handler_addr;
extern int keyboard_handler_addr;
void set_idt_entry(int vector, int handler);
void set_user_idt_entry(int vector, int handler);
void capture_handlers(void);
void setup_traps(void);
void on_default_trap(void);
void on_page_fault(void);

// --- main.c ---
extern char initpath[CFG_INITPATH_LEN];
void read_initpath(void);
int kmain(void);

// --- drivers ---
void serial_putc(int ch);    // drivers/console.c
void serial_write(char *s);
void panic(char *msg);
extern int kbd_chan;         // drivers/keyboard.c -- wait channel for blocked readers
int kbd_getc(void);
int kbd_eof(void);
void on_keyboard_irq(void);  // keyboard IRQ handler body (wakes blocked readers)
void disk_read_block(int blockno, int dst); // drivers/disk.c
int rtc_time(void);          // drivers/rtc.c
void power_off(void);        // drivers/power.c

#endif
