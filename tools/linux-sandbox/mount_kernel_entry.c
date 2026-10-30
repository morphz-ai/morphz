#define _GNU_SOURCE
/* Fixed synthetic integration driver for the production mount primitives.
 * No production service or arbitrary command interface is installed here. */
#include "mounts.h"
#include <json-c/json.h>
#include <sys/apparmor.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void fail(const char *why) {
    fprintf(stderr, "mount admission refused: %s (errno=%d)\n", why, errno);
    exit(78);
}
static struct json_object *field(struct json_object *object, const char *name, enum json_type type) {
    struct json_object *result = NULL;
    if (!json_object_object_get_ex(object, name, &result) || !json_object_is_type(result, type)) fail(name);
    return result;
}
static const char *text(struct json_object *object, const char *name) {
    struct json_object *value = field(object, name, json_type_string);
    const char *result = json_object_get_string(value);
    if ((size_t)json_object_get_string_len(value) != strlen(result)) fail("embedded NUL");
    return result;
}
static void label(const char *boot, const char *work) {
    char actual[512], expected[512], reverse[512];
    FILE *stream = fopen("/proc/self/attr/current", "re");
    if (!stream || !fgets(actual, sizeof(actual), stream)) fail("label read");
    fclose(stream);
    actual[strcspn(actual, "\n")] = 0;
    if (!work) {
        if (snprintf(expected, sizeof(expected), "%s (enforce)", boot) >= (int)sizeof(expected) ||
            strcmp(actual, expected)) fail("exact bootstrap label");
    } else {
        if (snprintf(expected, sizeof(expected), "%s//&%s (enforce)", boot, work) >= (int)sizeof(expected) ||
            snprintf(reverse, sizeof(reverse), "%s//&%s (enforce)", work, boot) >= (int)sizeof(reverse) ||
            (strcmp(actual, expected) && strcmp(actual, reverse))) fail("exact retained enforcing stack");
    }
}
static void send_phase(int control, const char *phase) {
    if (send(control, phase, strlen(phase), MSG_NOSIGNAL) != (ssize_t)strlen(phase)) fail("control send");
}
static void wait_host(int control) {
    char value;
    if (recv(control, &value, 1, 0) != 1 || value != 'G') fail("host gate");
}

int main(int argc, char **argv) {
    int outer = argc == 4 && !strcmp(argv[1], "--outer");
    int inner = argc == 3 && !strcmp(argv[1], "--inner");
    if ((!outer && !inner) || (outer && morphz_unprivileged())) fail("fixed non-root entry");
    char *end;
    long control_number = strtol(argv[2], &end, 10);
    if (!*argv[2] || *end || control_number < 4 || control_number > 1024) fail("fixed control descriptor");
    int control = (int)control_number;
    if (outer) {
        int source = open(argv[3], O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
        struct stat metadata;
        if (source < 0 || fstat(source, &metadata) || metadata.st_uid != 0 ||
            !S_ISREG(metadata.st_mode) || metadata.st_mode & 0022 || source == control)
            fail("root-owned fixed fixture");
        if (source != 3) {
            if (dup2(source, 3) != 3) fail("manifest handoff");
            close(source);
        }
    }
    struct stat manifest;
    if (fstat(3, &manifest) || !S_ISREG(manifest.st_mode) || manifest.st_size <= 0 ||
        manifest.st_size > 262144 || (fcntl(3, F_GETFL) & O_ACCMODE) != O_RDONLY)
        fail("bounded immutable manifest descriptor");
    char *raw = calloc((size_t)manifest.st_size + 1, 1);
    if (!raw || pread(3, raw, (size_t)manifest.st_size, 0) != manifest.st_size) fail("manifest bytes");
    struct json_tokener *parser = json_tokener_new();
    json_tokener_set_flags(parser, JSON_TOKENER_STRICT | JSON_TOKENER_VALIDATE_UTF8);
    struct json_object *object = json_tokener_parse_ex(parser, raw, (int)manifest.st_size);
    if (!object || json_tokener_get_error(parser) != json_tokener_success ||
        json_tokener_get_parse_end(parser) != (size_t)manifest.st_size) fail("manifest syntax");
    json_tokener_free(parser);
    free(raw);
    const char *boot = text(object, "bootstrap"), *work = text(object, "work");
    label(boot, NULL);
    if (getuid() != (uid_t)json_object_get_int64(field(object, "uid", json_type_int)) ||
        getgid() != (gid_t)json_object_get_int64(field(object, "gid", json_type_int))) fail("caller identity");
    struct morphz_mounts mounts = {.cwd = text(object, "cwd")};
    struct json_object *roots = field(object, "roots", json_type_array);
    mounts.count = json_object_array_length(roots);
    if (!mounts.count || mounts.count > MORPHZ_MAX_ROOTS) fail("root count");
    for (size_t i = 0; i < mounts.count; ++i) {
        struct json_object *root = json_object_array_get_idx(roots, i);
        mounts.roots[i] = (struct morphz_root){
            .path = text(root, "path"),
            .writable = json_object_get_boolean(field(root, "writable", json_type_boolean)),
            .fd = -1,
            .device = (dev_t)json_object_get_uint64(field(root, "device", json_type_int)),
            .inode = (ino_t)json_object_get_uint64(field(root, "inode", json_type_int)),
        };
    }
    if (outer) {
        if (morphz_pin_roots(&mounts)) fail("pin source objects");
        send_phase(control, "PIN");
        wait_host(control);
        struct json_object *hidden = field(object, "hidden", json_type_array);
        size_t hidden_count = json_object_array_length(hidden);
        if (hidden_count > 8) fail("hidden roots count");
        const char *hidden_paths[8];
        for (size_t i = 0; i < hidden_count; ++i) hidden_paths[i] = json_object_get_string(json_object_array_get_idx(hidden, i));
        struct morphz_argv arguments = {0};
        if (morphz_build_bwrap(&mounts, hidden_paths, hidden_count, 0, 0, &arguments)) fail("mount plan");
        if (morphz_arg(&arguments, "--") || morphz_arg(&arguments, text(object, "entry")) ||
            morphz_arg(&arguments, "--inner") || morphz_arg(&arguments, argv[2])) fail("fixed inner arguments");
        /* Only the post-fork, trusted launch process makes its own pins
         * inheritable. The final entry closes all of them before work. */
        for (size_t i = 0; i < mounts.count; ++i)
            if (fcntl(mounts.roots[i].fd, F_SETFD, 0)) fail("pin handoff");
        if (fcntl(3, F_SETFD, 0) || fcntl(control, F_SETFD, 0) ||
            prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) fail("handoff privileges");
        execv(arguments.values[0], arguments.values);
        fail("distribution bwrap exec");
    }
    if (morphz_finalize_mounts(&mounts)) fail("recursive read-only mount boundary");
    if (prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1 || morphz_verify_mounted_roots(&mounts))
        fail("actual mounted directory identity or access");
    if (aa_stack_profile(work)) fail("retained work stack");
    label(boot, work);
    if (morphz_unprivileged() || morphz_close_extra_fds(control)) fail("work privilege and FD closure");
    send_phase(control, "READY");
    close(control);
    execl("/usr/bin/python3", "/usr/bin/python3", "-I", "-B", text(object, "worker"), "--worker", (char *)NULL);
    fail("fixed synthetic worker");
}
