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

struct vm_area {
  int used;
  int start;
  int end;
  int prot;
  int flags;
  int file;
  int offset;
};

struct vm_space {
  int ptbr;
  int brk_start;
  int brk_end;
  struct vm_area areas[CFG_MAX_VMAS];
};

struct page_cache_entry {
  int used;
  int file;
  int fs_type;
  int object;
  int offset;
  int frame;
  int length;
  int dirty;
};

typedef int (*file_io_fn)(int file, int caller, int buf, int len);
typedef void (*file_lifecycle_fn)(int file);
typedef int (*file_poll_fn)(int file, int events);
typedef int (*vnode_io_fn)(int node, int caller, int off, int buf, int len);
typedef int (*vnode_getdents_fn)(
  int node, int caller, int off, int destination, int count
);
typedef void (*vnode_stat_fn)(int node, int st);
typedef int (*vnode_truncate_fn)(int node);
typedef void (*vnode_release_fn)(int node);

struct file_ops {
  file_io_fn read;
  file_io_fn write;
  file_lifecycle_fn close;
  file_lifecycle_fn retain;
  file_poll_fn poll;
};

struct vnode_ops {
  vnode_io_fn read;
  vnode_io_fn write;
  vnode_getdents_fn getdents;
  vnode_stat_fn stat;
  vnode_truncate_fn truncate;
  vnode_release_fn release;
};

struct inode {
  int inum;
  int type;
  int nlink;
  int mode;
  int uid;
  int gid;
  int size;
  int atime;
  int mtime;
  int ctime;
};

struct vnode {
  struct vnode_ops *ops;
  int fs_type;
  int object;
  struct inode inode;
};

struct mount {
  int used;
  int fs_type;
  int root_inum;
  char path[8];
};

// A registered character-device driver. The major number indexes the registry;
// `read`/`write` take the vnode_io_fn shape (node, caller, off, buf, len) so
// devfs can dispatch straight through them.
struct chardev {
  int used;
  int major;
  int mode;
  char name[12];
  vnode_io_fn read;
  vnode_io_fn write;
};

// A driver-owned IRQ line. The per-line trap stub funnels through
// irq_dispatch(), which invokes the registered handler.
typedef void (*irq_fn)(void);
struct irq_slot {
  int used;
  irq_fn handler;
  char owner[12];
};

struct guest_dirent {
  int ino;
  int offset;
  int reclen;
  int type;
  char name[16];
};

// Stable 32-bit userspace metadata layout. All fields are four bytes on the
// custom32 ABI, including timestamps.
struct guest_stat {
  int dev;
  int ino;
  int mode;
  int nlink;
  int uid;
  int gid;
  int rdev;
  int size;
  int blksize;
  int blocks;
  int atime;
  int mtime;
  int ctime;
};

// Stable custom32 termios layout used by TCGETS/TCSETS. The control-character
// indexes follow Linux for the subset implemented by the line discipline.
struct guest_termios {
  int iflag;
  int oflag;
  int cflag;
  int lflag;
  int line;
  int cc[12];
};

struct guest_winsize {
  int rows;
  int cols;
  int xpixel;
  int ypixel;
};

struct guest_pollfd {
  int fd;
  int events;
  int revents;
};

struct guest_sockaddr_in {
  int family;
  int port;
  int address;
};

struct udp_datagram {
  int length;
  int source_address;
  int source_port;
  char data[512];
};

struct socket {
  int used;
  int refs;
  int type;
  int protocol;
  int local_port;
  int local_address;
  int remote_address;
  int remote_port;
  int status_flags;
  int queue_head;
  int queue_count;
  struct udp_datagram queue[4];
};

// A descriptor points at an open-file object. The latter owns the shared file
// offset and reference count, so dup() and fork() preserve Unix open-file
// description semantics instead of copying the offset by value.
struct open_file {
  int used;
  int refs;
  int offset;
  int status_flags;
  struct vnode vnode;
};

struct file {
  struct file_ops *ops;
  int type;
  int readable;
  int writable;
  int pipe_end;
  int object;
  int fd_flags;
  int status_flags;
};

struct proc {
  int state;
  int parent;
  int exit_code;
  int chan;
  int pgid;
  int sid;
  int uid;
  int gid;
  int pending_signals;
  int blocked_signals;
  int signal_handlers[CFG_NSIG];
  int signal_masks[CFG_NSIG];
  int signal_restorers[CFG_NSIG];
  int in_signal;
  int signal_saved_mask;
  struct cpu_context signal_saved_ctx;
  int wait_event;
  int wait_signal;
  int sleep_deadline;
  int sleep_remaining;
  int poll_deadline;
  int tty_deadline;
  int tty_timed_out;
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
  int read_status_flags;
  int write_status_flags;
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
int do_waitpid(int parent, int pid, int status, int options);

// --- signal.c / process groups / controlling terminal ---
void signal_init_proc(int idx);
void signal_fork_proc(int child, int parent);
void signal_exec_proc(int idx);
int send_signal(int idx, int signal);
int send_signal_selector(int caller, int pid, int signal);
int send_signal_group(int pgid, int signal);
void notify_parent(int idx);
void prepare_signal(int idx);
int sys_sigaction(int caller, int signal, int action, int old_action);
int sys_sigprocmask(int caller, int how, int mask, int old_mask);
int sys_sigreturn(int caller);
int sys_setpgid(int caller, int pid, int pgid);
int sys_setsid(int caller);
int tty_set_foreground(int caller, int pgid);
int tty_get_foreground(void);
void tty_init(void);
void tty_receive(int ch);
void tty_close_input(void);
int tty_read(int caller, int buf, int len);
int tty_write(int caller, int buf, int len);
int tty_poll(int events);
int tty_getattr(int caller, int destination);
int tty_setattr(int caller, int source, int flush);
int tty_getwinsize(int caller, int destination);
int tty_setwinsize(int caller, int source);

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
void retain_frame(int frame);
int alloc_frame(void);
int free_frame_count(void);
void pmm_init(void);
void build_kernel_pt(void);
int new_address_space(void);
void map_page(int pd, int vaddr, int frame, int flags);
void copy_space(int src, int dst);
void free_space(int pd);
void vm_init(int proc, int pd, int image_end);
void vm_fork(int child, int parent);
void vm_release(int proc);
int vm_handle_page_fault(int proc, int address, int error);
int vm_brk(int proc, int address);
int vm_mmap(int proc, int args);
int vm_munmap(int proc, int address, int length);
int vm_mprotect(int proc, int address, int length, int prot);
void page_cache_flush_object(int object);
void page_cache_update_object(
  int object, int offset, int length, int source, int caller
);

// --- fs.c ---
extern int fs_size;
extern int fs_ninodes;
extern int fs_inodestart;
extern int fs_bmapstart;
extern int fs_mount_flags;
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
int inode_nlink(int inum);
int inode_mode(int inum);
int inode_uid(int inum);
int inode_gid(int inum);
int inode_size(int inum);
int inode_atime(int inum);
int inode_mtime(int inum);
int inode_ctime(int inum);
int inode_slot(int inum, int k);
void inode_set16(int inum, int offset, int value);
void inode_set32(int inum, int offset, int value);
void disk_vnode_init(struct vnode *node, int inum);
int bmap(int inum, int bn);
int bmap_alloc(int inum, int bn);
int readi(int inum, int off, int n, int dst);
int writei(int inum, int off, int n, int src);
void itrunc(int inum);
int disk_vnode_read(struct vnode *node, int off, int n, int dst);
int disk_vnode_write(struct vnode *node, int off, int n, int src);
int name_eq(int dname, int want, int wlen);
int dirlookup(int dir, int name, int namelen);
int dirlink(int dir, int name, int namelen, int inum);
int dirunlink(int dir, int name, int namelen);
int dir_is_empty(int dir);
int namei(int path);
int namei_nofollow(int path);
int namei_access(int path, int follow_final, int uid, int gid);
int nameiparent(int path, int name);
int create_inode(int path, int type, int mode);
int inode_is_open(int inum);
int inode_open_count(int inum);
int unlink_path(int path, int remove_dir);
int link_path(int oldpath, int newpath);
int rename_path(int oldpath, int newpath);
int symlink_path(int target, int linkpath);
int readlink_path(int path, int dst, int size);
int chmod_path(int path, int mode);
int chown_path(int path, int uid, int gid);
void inode_stat(int inum, struct guest_stat *st);
int inode_access(int inum, int uid, int gid, int mask);
extern int fs_lookup_error;
extern int fs_redirect_valid;
extern char fs_redirect_path[CFG_INITPATH_LEN];

// --- vfs.c ---
extern struct vnode_ops disk_vnode_ops;
extern struct vnode_ops dev_vnode_ops;
extern struct vnode_ops proc_vnode_ops;
extern struct vnode_ops tmp_vnode_ops;
extern struct mount mount_table[CFG_NMOUNT];
void vfs_init(void);
int vfs_lookup(int path, int follow, int caller, struct vnode *node);
int vfs_create(int path, int type, int mode, int caller, struct vnode *node);
int vfs_unlink(int path, int remove_dir, int caller);
int vfs_link(int oldpath, int newpath);
int vfs_rename(int oldpath, int newpath);
int vfs_symlink(int target, int linkpath);
int vfs_chmod(int path, int mode, int caller);
int vfs_chown(int path, int uid, int gid, int caller);
int vfs_readlink(int path, int caller, int dst, int size);
int vnode_read(struct vnode *node, int caller, int off, int n, int dst);
int vnode_write(struct vnode *node, int caller, int off, int n, int src);
int vnode_getdents(
  struct vnode *node, int caller, int off, int destination, int count
);
void vnode_stat(struct vnode *node, struct guest_stat *st);
int vnode_truncate(struct vnode *node);
void vnode_release(struct vnode *node);
int vnode_access(struct vnode *node, int uid, int gid, int mask);
int vnode_is_tty(struct vnode *node);
char *vfs_mounted_path(int inum);
// Shared VFS helpers used by the pseudo-filesystems (vfs.c and device.c).
void vnode_fill(
  struct vnode *node, struct vnode_ops *ops, int fs_type, int object,
  int type, int mode, int size
);
void generic_stat_op(int node_addr, int stat_addr);
int emit_dirent(
  int caller, int destination, int ino, int offset, int type, char *name
);
int append_text(char *dst, int at, char *text);
int append_number(char *dst, int at, int value);

// --- device.c (Linux-like device/driver model) ---
extern struct chardev chardev_table[CFG_NCHARDEV];
extern struct irq_slot irq_table[CFG_NIRQ];
extern struct vnode_ops sys_vnode_ops;
void device_init(void);
void register_chardev(
  int major, char *name, int mode, vnode_io_fn read, vnode_io_fn write
);
int chardev_lookup(char *name);
int chardev_rdev(int major);
int chardev_read(int major, int node, int caller, int off, int buf, int len);
int chardev_write(int major, int node, int caller, int off, int buf, int len);
int request_irq(int line, irq_fn handler, char *owner);
void irq_dispatch(int line);
int sys_lookup(char *relative, struct vnode *node);

// --- file.c (per-process file descriptors) ---
extern struct file_ops console_file_ops;
extern struct file_ops keyboard_file_ops;
extern struct file_ops vnode_file_ops;
extern struct file_ops pipe_file_ops;
extern struct file_ops socket_file_ops;
extern struct open_file open_file_table[CFG_NFILE];
void file_init(void);
void file_reset(struct file *file);
void file_set_console(struct file *file);
void file_set_keyboard(struct file *file);
int file_set_vnode(struct file *file, int inum);
int file_set_node(struct file *file, struct vnode *node);
void file_set_pipe(struct file *file, int pipe, int end);
void file_set_socket(struct file *file, int socket);
int file_read(struct file *file, int caller, int buf, int len);
int file_write(struct file *file, int caller, int buf, int len);
void file_close(struct file *file);
void file_retain(struct file *file);
void copy_file(struct file *dst, struct file *src);
void init_fds(int idx);
int alloc_fd(int idx);
int alloc_fd_from(int idx, int minimum);
void fd_close(int idx, int fd);
void clear_fds(int idx);
void copy_fds(int dst, int src);
void close_exec_fds(int idx);
int file_mmap_read(struct file *file, int offset, int length, int destination);
int file_mmap_retain(struct file *file);
void file_mmap_retain_object(int object);
void file_mmap_release(int object);
int file_mmap_read_object(int object, int offset, int length, int destination);
int file_mmap_write_object(int object, int offset, int length, int source);
int file_mmap_size_object(int object);
int file_mmap_identity(int object, int *fs_type, int *node_object);
int file_getdents(struct file *file, int caller, int destination, int count);
int file_is_tty(struct file *file);
int file_stat(struct file *file, struct guest_stat *st);
int file_lseek(struct file *file, int offset, int whence);
int file_poll(struct file *file, int events);
int file_get_status_flags(struct file *file);
void file_set_status_flags(struct file *file, int flags);

// --- pipe.c ---
extern struct pipe pipe_table[CFG_NPIPE];
int alloc_pipe(void);
int pipe_write_bytes(int pp, int buf, int len);
int pipe_read_bytes(int pp, int buf, int len);

// --- network.c / drivers/network.c ---
extern struct socket socket_table[CFG_NSOCKET];
extern int poll_chan;
void poll_wakeup(void);
void network_init(void);
void on_network_irq(void);
void net_receive_frame(char *frame, int length);
int socket_create(int caller, int domain, int type, int protocol);
int socket_bind(int caller, int fd, int address, int length);
int socket_connect(int caller, int fd, int address, int length);
int socket_listen(int caller, int fd, int backlog);
int socket_accept(int caller, int fd, int address, int length);
int socket_setsockopt(int caller, int fd, int args);
int socket_send(int caller, int fd, int buffer, int length);
int socket_recv(int caller, int fd, int buffer, int length);
int socket_send_object(int caller, int socket, int buffer, int length);
int socket_recv_object(int caller, int socket, int buffer, int length);
int socket_sendto(int caller, int fd, int args);
int socket_recvfrom(int caller, int fd, int args);
int socket_poll(int socket, int events);
void socket_close(int socket);
void socket_retain(int socket);

// --- exec.c ---
extern char kpath[CFG_INITPATH_LEN]; // a path copied in from user memory
extern char exec_hdr[12];            // the executable header (magic, entry, memSize)
extern char argbuf[CFG_ARGBUF_LEN];  // packed NUL-terminated argv strings
extern int arg_off[CFG_MAXARG];      // start offset of each arg in argbuf
extern char envbuf[CFG_ARGBUF_LEN];  // packed NUL-terminated environment strings
extern int env_off[CFG_MAXARG];      // start offset of each entry in envbuf
extern int g_argc;                   // argument count staged for the next spawn
extern int g_envc;                   // environment count staged for the next spawn
extern int g_exec_image_end;         // page-aligned end of the staged executable image
int copy_path_in(int proc, int upath);
void build_args_single(int kstr);
int build_args_from_user(int proc, int uargv);
int build_env_from_user(int proc, int uenvp);
int load_exec_image(int pd, int path);
int setup_user_args(int idx, int pd);
int spawn(int idx, int path);
int do_exec(int idx, int upath, int uargv, int uenvp);

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
int sys_fcntl(int caller, int fd, int command, int argument);
int sys_ioctl(int caller, int fd, int request, int argument);
int sys_getdents(int caller, int fd, int destination, int count);
int sys_poll(int caller, int fds, int count, int timeout);
int sys_stat_path(int caller, int upath, int destination, int follow);
int sys_fstat(int caller, int fd, int destination);
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
extern int network_handler_addr;
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
void kbd_drain(void);
void keyboard_init(void);
void keyboard_isr(void);     // registered keyboard IRQ handler (wakes blocked readers)
void on_keyboard_irq(void);  // keyboard trap stub entry: routes through irq_dispatch
void network_drain(void);    // drivers/network.c -- registered network IRQ handler
void disk_read_block(int blockno, int dst); // drivers/disk.c
void disk_write_block(int blockno, int src);
int rtc_time(void);          // drivers/rtc.c
void power_off(void);        // drivers/power.c

#endif
