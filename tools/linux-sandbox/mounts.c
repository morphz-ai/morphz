#define _GNU_SOURCE
#include "mounts.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <unistd.h>

static int refuse(void) { errno = EPERM; return -1; }

int morphz_unprivileged(void) {
    uid_t ruid, euid, suid;
    gid_t rgid, egid, sgid;
    if (getresuid(&ruid, &euid, &suid) || getresgid(&rgid, &egid, &sgid) ||
        ruid == 0 || ruid != euid || ruid != suid || rgid != egid || rgid != sgid)
        return refuse();
    FILE *stream = fopen("/proc/self/status", "re");
    if (!stream) return -1;
    char line[1024];
    unsigned flags = 0;
    int invalid = 0;
    while (fgets(line, sizeof(line), stream)) {
        unsigned a, b, c, d;
        unsigned long long bits;
        if (sscanf(line, "Uid: %u %u %u %u", &a, &b, &c, &d) == 4) {
            flags |= 1;
            invalid |= a != ruid || b != ruid || c != ruid || d != ruid;
        }
        if (sscanf(line, "Gid: %u %u %u %u", &a, &b, &c, &d) == 4) {
            flags |= 2;
            invalid |= a != rgid || b != rgid || c != rgid || d != rgid;
        }
        const char *keys[] = {"CapEff:", "CapPrm:", "CapInh:", "CapAmb:"};
        for (unsigned i = 0; i < 4; ++i) {
            if (!strncmp(line, keys[i], strlen(keys[i])) &&
                sscanf(line + strlen(keys[i]), "%llx", &bits) == 1) {
                flags |= 4u << i;
                invalid |= bits != 0;
            }
        }
    }
    int read_error = ferror(stream);
    fclose(stream);
    return read_error || invalid || flags != 63 ? refuse() : 0;
}

int morphz_literal_path(const char *path) {
    if (!path || path[0] != '/' || strlen(path) >= PATH_MAX) return refuse();
    if (!strcmp(path, "/")) return 0;
    const char *at = path + 1;
    while (*at) {
        size_t size = strcspn(at, "/");
        if (!size || (size == 1 && at[0] == '.') ||
            (size == 2 && at[0] == '.' && at[1] == '.')) return refuse();
        at += size;
        if (*at && !*++at) return refuse();
    }
    return 0;
}

int morphz_open_directory(const char *path) {
    if (morphz_literal_path(path)) return -1;
    int fd = open("/", O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return -1;
    const char *at = path + 1;
    while (*at) {
        char part[NAME_MAX + 1];
        size_t size = strcspn(at, "/");
        if (size > NAME_MAX) { close(fd); errno = ENAMETOOLONG; return -1; }
        memcpy(part, at, size);
        part[size] = 0;
        int next = openat(fd, part, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        int failure = errno;
        close(fd);
        if (next < 0) { errno = failure; return -1; }
        fd = next;
        at += size;
        if (*at) ++at;
    }
    return fd;
}

static int contains(const char *root, const char *path) {
    size_t length = strlen(root);
    return !strcmp(root, "/") || (!strncmp(root, path, length) &&
                                 (path[length] == 0 || path[length] == '/'));
}

void morphz_close_roots(struct morphz_mounts *mounts) {
    for (size_t i = 0; i < mounts->count && i < MORPHZ_MAX_ROOTS; ++i) {
        if (mounts->roots[i].fd >= 0) close(mounts->roots[i].fd);
        mounts->roots[i].fd = -1;
    }
}

int morphz_pin_roots(struct morphz_mounts *mounts) {
    if (!mounts || !mounts->count || mounts->count > MORPHZ_MAX_ROOTS ||
        morphz_literal_path(mounts->cwd) || morphz_unprivileged()) return refuse();
    for (size_t i = 0; i < mounts->count; ++i) mounts->roots[i].fd = -1;
    int writable = 0, cwd_allowed = 0;
    for (size_t i = 0; i < mounts->count; ++i) {
        struct morphz_root *root = &mounts->roots[i];
        if (morphz_literal_path(root->path) || (root->writable != 0 && root->writable != 1))
            goto failed;
        writable |= root->writable;
        cwd_allowed |= contains(root->path, mounts->cwd);
        root->fd = morphz_open_directory(root->path);
        struct stat info;
        if (root->fd < 0 || fstat(root->fd, &info)) goto failed;
        /* Registration pins the object actually opened by the non-root
         * launcher. The service freezes these identities for inner admission. */
        root->device = info.st_dev;
        root->inode = info.st_ino;
    }
    if (!writable || !cwd_allowed) goto failed;
    return 0;
failed:
    { int failure = errno; morphz_close_roots(mounts); errno = failure ? failure : EPERM; }
    return -1;
}

int morphz_arg(struct morphz_argv *arguments, const char *value) {
    if (!value || arguments->count + 1 >= MORPHZ_MAX_ARGS) { errno = E2BIG; return -1; }
    char *copy = strdup(value);
    if (!copy) return -1;
    arguments->values[arguments->count++] = copy;
    arguments->values[arguments->count] = NULL;
    return 0;
}

void morphz_free_argv(struct morphz_argv *arguments) {
    for (size_t i = 0; i < arguments->count; ++i) free(arguments->values[i]);
    arguments->count = 0;
    arguments->values[0] = NULL;
}

static int pair(struct morphz_argv *args, const char *a, const char *b) {
    return morphz_arg(args, a) || morphz_arg(args, b) ? -1 : 0;
}

static int triple(struct morphz_argv *args, const char *a, const char *b, const char *c) {
    return pair(args, a, b) || morphz_arg(args, c) ? -1 : 0;
}

static size_t depth(const char *path) {
    size_t result = 0;
    for (; *path; ++path) result += *path == '/';
    return result;
}

static int root_order(const void *a, const void *b) {
    const struct morphz_root *left = *(const struct morphz_root *const *)a;
    const struct morphz_root *right = *(const struct morphz_root *const *)b;
    if (left->writable != right->writable) return left->writable - right->writable;
    size_t l = depth(left->path), r = depth(right->path);
    return l == r ? strcmp(left->path, right->path) : (l < r ? -1 : 1);
}

int morphz_build_bwrap(const struct morphz_mounts *mounts,
                       const char *const *hidden, size_t hidden_count,
                       int private_pty, int allow_network, struct morphz_argv *args) {
    if (!mounts || !mounts->count || mounts->count > MORPHZ_MAX_ROOTS ||
        hidden_count > 8 || (hidden_count && !hidden) || args->count ||
        (private_pty != 0 && private_pty != 1) || (allow_network != 0 && allow_network != 1) ||
        morphz_unprivileged()) return refuse();
    const char *fixed[] = {"/usr/bin/bwrap", "--die-with-parent", "--ro-bind", "/", "/",
        "--dev", "/dev", "--unshare-user", "--unshare-pid", "--unshare-ipc",
        "--proc", "/proc", "--cap-drop", "ALL"};
    for (size_t i = 0; i < sizeof(fixed) / sizeof(fixed[0]); ++i)
        if (morphz_arg(args, fixed[i])) goto failed;
    if ((!private_pty && morphz_arg(args, "--new-session")) ||
        (!allow_network && morphz_arg(args, "--unshare-net"))) goto failed;
    for (size_t i = 0; i < hidden_count; ++i) {
        if (morphz_literal_path(hidden[i]) || !strcmp(hidden[i], "/") ||
            pair(args, "--tmpfs", hidden[i])) goto failed;
    }
    const struct morphz_root *ordered[MORPHZ_MAX_ROOTS];
    for (size_t i = 0; i < mounts->count; ++i) ordered[i] = &mounts->roots[i];
    qsort(ordered, mounts->count, sizeof(ordered[0]), root_order);
    for (size_t i = 0; i < mounts->count; ++i) {
        const struct morphz_root *root = ordered[i];
        struct stat info;
        if (morphz_literal_path(root->path) || fstat(root->fd, &info) ||
            !S_ISDIR(info.st_mode) || info.st_dev != root->device || info.st_ino != root->inode)
            goto failed;
        if (!root->writable && !strcmp(root->path, "/")) continue;
        char source[64];
        snprintf(source, sizeof(source), "/proc/self/fd/%d", root->fd);
        /* bwrap 0.9 resolves bind sources, including /proc/self/fd, to paths.
         * Consequently this alone is NOT an atomic FD-mount guarantee.
         * Inner admission MUST compare every actual destination with the
         * retained object's identity before executing any untrusted work. */
        if (triple(args, root->writable ? "--bind" : "--ro-bind", source, root->path)) goto failed;
    }
    for (size_t i = 0; i < hidden_count; ++i) {
        int writable = 0;
        for (size_t j = 0; j < mounts->count; ++j)
            writable |= mounts->roots[j].writable && !strcmp(hidden[i], mounts->roots[j].path);
        if (!writable && pair(args, "--remount-ro", hidden[i])) goto failed;
    }
    if (pair(args, "--chdir", mounts->cwd)) goto failed;
    return 0;
failed:
    morphz_free_argv(args);
    return -1;
}

int morphz_verify_mounted_roots(const struct morphz_mounts *mounts) {
    if (!mounts || !mounts->count || mounts->count > MORPHZ_MAX_ROOTS ||
        morphz_unprivileged()) return refuse();
    for (size_t i = 0; i < mounts->count; ++i) {
        const struct morphz_root *root = &mounts->roots[i];
        int descriptor = morphz_open_directory(root->path);
        struct stat info;
        struct statvfs filesystem;
        if (descriptor < 0) return -1;
        int invalid = fstat(descriptor, &info) || fstatvfs(descriptor, &filesystem);
        int failure = errno;
        close(descriptor);
        if (invalid) { errno = failure; return -1; }
        if (info.st_dev != root->device || info.st_ino != root->inode) return refuse();
        int writable = 0;
        for (size_t j = 0; j < mounts->count; ++j)
            writable |= mounts->roots[j].writable && contains(mounts->roots[j].path, root->path);
        if (!!(filesystem.f_flag & ST_RDONLY) == writable) return refuse();
    }
    int cwd = morphz_open_directory(mounts->cwd);
    if (cwd < 0) return -1;
    close(cwd);
    return 0;
}

int morphz_close_extra_fds(int keep) {
    DIR *directory = opendir("/proc/self/fd");
    if (!directory) return -1;
    int listing = dirfd(directory), result = 0;
    struct dirent *item;
    errno = 0;
    while ((item = readdir(directory))) {
        char *end;
        long descriptor = strtol(item->d_name, &end, 10);
        if (*item->d_name && !*end && descriptor > 2 && descriptor <= INT_MAX &&
            descriptor != keep && descriptor != listing && close((int)descriptor)) result = -1;
        errno = 0;
    }
    if (errno) result = -1;
    if (closedir(directory)) result = -1;
    return result;
}
