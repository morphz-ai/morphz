#ifndef MORPHZ_SANDBOX_MOUNTS_H
#define MORPHZ_SANDBOX_MOUNTS_H

/* Non-privileged mount/admission primitives for the native launcher. These
 * functions make no authorization decision and never run a work command.
 * The caller must obtain the frozen policy from the authenticated service. */
#include <stddef.h>
#include <sys/types.h>

#define MORPHZ_MAX_ROOTS 512
#define MORPHZ_MAX_ARGS 16384

struct morphz_root {
    const char *path;
    int writable;
    int fd;
    dev_t device;
    ino_t inode;
};

struct morphz_mounts {
    struct morphz_root roots[MORPHZ_MAX_ROOTS];
    size_t count;
    const char *cwd;
};

struct morphz_argv {
    char *values[MORPHZ_MAX_ARGS];
    size_t count;
};

int morphz_unprivileged(void);
int morphz_literal_path(const char *path);
int morphz_open_directory(const char *path);
int morphz_pin_roots(struct morphz_mounts *mounts);
void morphz_close_roots(struct morphz_mounts *mounts);
int morphz_verify_mounted_roots(const struct morphz_mounts *mounts);
int morphz_build_bwrap(const struct morphz_mounts *mounts,
                       const char *const *hidden, size_t hidden_count,
                       int private_pty, int allow_network, struct morphz_argv *arguments);
int morphz_arg(struct morphz_argv *arguments, const char *value);
void morphz_free_argv(struct morphz_argv *arguments);
int morphz_close_extra_fds(int keep);

#endif
