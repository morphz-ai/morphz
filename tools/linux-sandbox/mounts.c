#define _GNU_SOURCE
#include "mounts.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/capability.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

static int refuse(void) { errno = EPERM; return -1; }

static int credentials(unsigned long long expected_caps) {
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
                invalid |= bits != expected_caps;
            }
        }
    }
    int read_error = ferror(stream);
    fclose(stream);
    return read_error || invalid || flags != 63 ? refuse() : 0;
}

int morphz_unprivileged(void) { return credentials(0); }

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

int morphz_open_object(const char *path) {
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
        int next = openat(fd, part, O_PATH | O_NOFOLLOW | O_CLOEXEC |
                          (at[size] ? O_DIRECTORY : 0));
        int failure = errno;
        close(fd);
        if (next < 0) { errno = failure; return -1; }
        fd = next;
        at += size;
        if (*at) ++at;
    }
    return fd;
}

int morphz_open_directory(const char *path) {
    int fd = morphz_open_object(path);
    struct stat info;
    if (fd < 0) return -1;
    if (fstat(fd, &info) || !S_ISDIR(info.st_mode)) {
        close(fd);
        return refuse();
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
        root->fd = morphz_open_object(root->path);
        struct stat info;
        if (root->fd < 0 || fstat(root->fd, &info) ||
            (!S_ISDIR(info.st_mode) && !S_ISREG(info.st_mode))) goto failed;
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
        "--proc", "/proc", "--cap-drop", "ALL", "--cap-add", "CAP_SYS_ADMIN",
        "--cap-add", "CAP_SETPCAP"};
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
            (!S_ISDIR(info.st_mode) && !S_ISREG(info.st_mode)) ||
            info.st_dev != root->device || info.st_ino != root->inode)
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

static int mount_path(char *output, const char *encoded) {
    size_t count = 0;
    while (*encoded) {
        unsigned char value = (unsigned char)*encoded++;
        if (value == '\\') {
            if (strlen(encoded) < 3 || encoded[0] < '0' || encoded[0] > '7' ||
                encoded[1] < '0' || encoded[1] > '7' || encoded[2] < '0' || encoded[2] > '7')
                return refuse();
            unsigned decoded = (encoded[0] - '0') * 64 + (encoded[1] - '0') * 8 + encoded[2] - '0';
            if (!decoded || decoded > 255) return refuse();
            value = (unsigned char)decoded;
            encoded += 3;
        }
        if (count + 1 >= PATH_MAX) return refuse();
        output[count++] = (char)value;
    }
    output[count] = 0;
    return morphz_literal_path(output);
}

static int descriptor_mount_id(int descriptor, unsigned long *result) {
    char path[64], line[256];
    snprintf(path, sizeof(path), "/proc/self/fdinfo/%d", descriptor);
    FILE *stream = fopen(path, "re");
    if (!stream) return -1;
    int found = 0;
    while (fgets(line, sizeof(line), stream))
        if (sscanf(line, "mnt_id: %lu", result) == 1) found = 1;
    int failure = ferror(stream);
    fclose(stream);
    return !found || failure ? refuse() : 0;
}

static int drop_setup_capabilities(void) {
    if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0)) return -1;
    for (int capability = 0; ; ++capability) {
        int present = prctl(PR_CAPBSET_READ, capability, 0, 0, 0);
        if (present < 0) {
            if (errno == EINVAL) break;
            return -1;
        }
        if (present && prctl(PR_CAPBSET_DROP, capability, 0, 0, 0)) return -1;
    }
    struct __user_cap_header_struct header = {_LINUX_CAPABILITY_VERSION_3, 0};
    struct __user_cap_data_struct data[2] = {{0}};
    if (syscall(SYS_capset, &header, data) || morphz_unprivileged()) return -1;
    for (int capability = 0; ; ++capability) {
        int present = prctl(PR_CAPBSET_READ, capability, 0, 0, 0);
        if (present < 0 && errno == EINVAL) return 0;
        if (present != 0) return refuse();
    }
}

int morphz_finalize_mounts(const struct morphz_mounts *mounts) {
    /* Only the static trusted entry runs with these two namespace-local setup
     * capabilities. General work never inherits them, even in the bounding set.
     * bwrap's devpts setup uses a parent user namespace; take a mount namespace
     * owned by the final user namespace before changing its mount attributes. */
    const unsigned long long setup = (1ULL << CAP_SYS_ADMIN) | (1ULL << CAP_SETPCAP);
    if (!mounts || !mounts->count || mounts->count > MORPHZ_MAX_ROOTS || credentials(setup) ||
        prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1) return refuse();
    FILE *mapping = fopen("/proc/self/uid_map", "re");
    unsigned long inside, outside, length;
    char extra;
    if (!mapping) return -1;
    int fields = fscanf(mapping, "%lu %lu %lu %c", &inside, &outside, &length, &extra);
    fclose(mapping);
    if (fields != 3 || inside != getuid() || length != 1) return refuse();
    if (unshare(CLONE_NEWNS) || mount(NULL, "/", NULL, MS_PRIVATE | MS_REC, NULL)) return -1;

    /* Pin only visible, already-writable mounts within the positive grants.
     * Saving these before the recursive seal preserves nested host read-only
     * mounts and exact-file grants. Never make an entire grant recursively rw. */
    enum { MAX_WRITABLE_MOUNTS = 4096, MAX_MOUNT_RECORDS = 65536 };
    int descriptors[MAX_WRITABLE_MOUNTS];
    size_t count = 0, records = 0, capacity = 0;
    char *line = NULL;
    FILE *table = fopen("/proc/self/mountinfo", "re");
    if (!table) return -1;
    ssize_t size;
    while ((size = getline(&line, &capacity, table)) >= 0) {
        if (size > 262144 || ++records > MAX_MOUNT_RECORDS) goto failed;
        char *state, *parts[6];
        parts[0] = strtok_r(line, " ", &state);
        for (size_t i = 1; i < 6; ++i) parts[i] = strtok_r(NULL, " ", &state);
        if (!parts[5]) goto failed;
        if (strcmp(parts[5], "rw") && strncmp(parts[5], "rw,", 3)) continue;
        char path[PATH_MAX];
        if (mount_path(path, parts[4])) goto failed;
        int allowed = contains("/dev", path) || contains("/proc", path);
        for (size_t i = 0; i < mounts->count; ++i)
            allowed |= mounts->roots[i].writable && contains(mounts->roots[i].path, path);
        if (!allowed) continue;
        char *end;
        unsigned long expected = strtoul(parts[0], &end, 10), actual;
        if (*end || !expected || count == MAX_WRITABLE_MOUNTS) goto failed;
        int descriptor = morphz_open_object(path);
        if (descriptor < 0) goto failed;
        if (descriptor_mount_id(descriptor, &actual)) { close(descriptor); goto failed; }
        // A covered underlying mount must remain sealed, not restored via the
        // different mount currently visible at that pathname.
        if (actual != expected) { close(descriptor); continue; }
        descriptors[count++] = descriptor;
    }
    if (ferror(table) || !records) goto failed;
    struct mount_attr readonly = {.attr_set = MOUNT_ATTR_RDONLY};
    if (mount_setattr(AT_FDCWD, "/", AT_RECURSIVE, &readonly, sizeof(readonly))) goto failed;
    struct mount_attr writable = {.attr_clr = MOUNT_ATTR_RDONLY};
    for (size_t i = 0; i < count; ++i)
        if (mount_setattr(descriptors[i], "", AT_EMPTY_PATH, &writable, sizeof(writable))) goto failed;
    for (size_t i = 0; i < count; ++i) close(descriptors[i]);
    free(line);
    fclose(table);
    return drop_setup_capabilities();
failed:
    { int failure = errno;
      for (size_t i = 0; i < count; ++i) close(descriptors[i]);
      free(line);
      fclose(table);
      errno = failure ? failure : EPERM; }
    return -1;
}

int morphz_verify_mounted_roots(const struct morphz_mounts *mounts) {
    if (!mounts || !mounts->count || mounts->count > MORPHZ_MAX_ROOTS ||
        morphz_unprivileged()) return refuse();
    for (size_t i = 0; i < mounts->count; ++i) {
        const struct morphz_root *root = &mounts->roots[i];
        int descriptor = morphz_open_object(root->path);
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
