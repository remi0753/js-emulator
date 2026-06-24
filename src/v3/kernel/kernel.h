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

// --- scheduler.c ---
extern int ticks;
extern int current;
void save_ctx(int i);
void load_ctx(int i);
int schedule(void);
void switch_to_next(void);
void on_timer(void);

// --- process.c ---
extern int nproc;
extern int proc_state[CFG_MAX_PROC];   // unused / runnable / zombie / blocked / pipewait
extern int proc_parent[CFG_MAX_PROC];  // parent slot, -1 for the initial process
extern int proc_exit_code[CFG_MAX_PROC];
extern int proc_ptbr[CFG_MAX_PROC];
extern int proc_regs[CFG_PROC_REG_COUNT]; // proc * 8 + register number
extern int proc_pc[CFG_MAX_PROC];
extern int proc_sp[CFG_MAX_PROC];
extern int proc_flags[CFG_MAX_PROC];
extern int proc_mode[CFG_MAX_PROC];
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
int user_access_ok(int proc, int addr, int len, int write);
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
int bmap(int inum, int bn);
int readi(int inum, int off, int n, int dst);
int name_eq(int dname, int want, int wlen);
int dirlookup(int dir, int name, int namelen);
int namei(int path);

// --- file.c (per-process file descriptors) ---
extern int proc_fd_type[CFG_FD_TABLE_LEN]; // none / console / keyboard / file / pipe
extern int proc_fd_inum[CFG_FD_TABLE_LEN];
extern int proc_fd_off[CFG_FD_TABLE_LEN];
extern int proc_fd_pipe[CFG_FD_TABLE_LEN];
extern int proc_fd_pend[CFG_FD_TABLE_LEN]; // pipe end: 0 = read, 1 = write
void init_fds(int idx);
int alloc_fd(int idx);
void fd_close(int idx, int fd);
void clear_fds(int idx);
void copy_fds(int dst, int src);

// --- pipe.c ---
extern int pipe_used[CFG_NPIPE];
extern int pipe_count[CFG_NPIPE]; // bytes currently buffered
extern int pipe_head[CFG_NPIPE];  // read position
extern int pipe_nread[CFG_NPIPE]; // open read ends
extern int pipe_nwrite[CFG_NPIPE]; // open write ends
extern char pipe_buf[CFG_PIPE_BUF_LEN]; // NPIPE * PIPESZ
int alloc_pipe(void);
int pipe_write_bytes(int pp, int buf, int len);
int pipe_read_bytes(int pp, int buf, int len);
void wake_pipe_waiters(void);

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
extern int g_blocked; // set by a syscall that blocked the caller (don't write its R0)
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
int kbd_getc(void);          // drivers/keyboard.c
int kbd_eof(void);
void disk_read_block(int blockno, int dst); // drivers/disk.c
int rtc_time(void);          // drivers/rtc.c
void power_off(void);        // drivers/power.c

#endif
