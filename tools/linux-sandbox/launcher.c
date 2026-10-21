#define _GNU_SOURCE
/* Administrator-installed, statically linked and never setuid. No work runs
 * before the privileged service authenticates the actual inner boundary.
 * The service receives policy only, never command text or environment. */
#include "mounts.h"
#include <json-c/json.h>
#include <sys/apparmor.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define CONTROL "/run/morphz-sandbox/control.sock"
#define MAX_HANDOFF (4 * 1024 * 1024)
extern char **environ;

static void fail(const char *message) {
    fprintf(stderr, "Morphz Linux sandbox startup refused: %s (errno=%d)\n", message, errno);
    exit(78);
}
static struct json_object *field(struct json_object *object, const char *key, enum json_type kind) {
    struct json_object *value = NULL;
    if (!json_object_object_get_ex(object, key, &value) || !json_object_is_type(value, kind)) fail(key);
    return value;
}
static const char *string(struct json_object *object, const char *key) {
    struct json_object *value = field(object, key, json_type_string);
    const char *raw = json_object_get_string(value);
    if ((size_t)json_object_get_string_len(value) != strlen(raw)) fail("embedded NUL");
    return raw;
}
static struct json_object *decode(const char *raw, size_t size) {
    struct json_tokener *parser = json_tokener_new();
    if (!parser || size > MAX_HANDOFF) fail("bounded handoff syntax");
    json_tokener_set_flags(parser, JSON_TOKENER_STRICT | JSON_TOKENER_VALIDATE_UTF8);
    struct json_object *value = json_tokener_parse_ex(parser, raw, (int)size);
    if (json_tokener_get_error(parser) != json_tokener_success ||
        json_tokener_get_parse_end(parser) != size || !json_object_is_type(value, json_type_object))
        fail("invalid handoff object");
    json_tokener_free(parser);
    return value;
}
static int connect_service(const char *path) {
    int fd = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
    struct sockaddr_un address = {.sun_family = AF_UNIX};
    struct timeval timeout = {.tv_sec = 10};
    if (fd < 0 || strlen(path) >= sizeof(address.sun_path) ||
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) ||
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout))) fail("service socket");
    strcpy(address.sun_path, path);
    if (connect(fd, (struct sockaddr *)&address, sizeof(address))) fail("policy service unavailable");
    struct ucred server;
    socklen_t length = sizeof(server);
    if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &server, &length) || server.uid != 0)
        fail("policy service identity");
    return fd;
}
static struct json_object *request(const char *operation, const char *launch) {
    struct json_object *value = json_object_new_object();
    json_object_object_add(value, "op", json_object_new_string(operation));
    json_object_object_add(value, "launch", json_object_new_string(launch));
    return value;
}
static struct json_object *exchange(int connection, struct json_object *value, int *received) {
    const char *raw = json_object_to_json_string_ext(value, JSON_C_TO_STRING_PLAIN);
    if (send(connection, raw, strlen(raw), MSG_NOSIGNAL) != (ssize_t)strlen(raw)) fail("control write");
    char buffer[262145];
    union { struct cmsghdr align; char bytes[CMSG_SPACE(sizeof(int) * 4)]; } ancillary;
    struct iovec vector = {.iov_base = buffer, .iov_len = sizeof(buffer) - 1};
    struct msghdr message = {.msg_iov = &vector, .msg_iovlen = 1,
                            .msg_control = ancillary.bytes, .msg_controllen = sizeof(ancillary.bytes)};
    ssize_t count = recvmsg(connection, &message, MSG_CMSG_CLOEXEC);
    if (count <= 0 || message.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) fail("bounded control reply");
    *received = -1;
    for (struct cmsghdr *item = CMSG_FIRSTHDR(&message); item; item = CMSG_NXTHDR(&message, item)) {
        if (item->cmsg_level != SOL_SOCKET || item->cmsg_type != SCM_RIGHTS ||
            item->cmsg_len != CMSG_LEN(sizeof(int)) || *received != -1) fail("unexpected capability");
        memcpy(received, CMSG_DATA(item), sizeof(int));
    }
    close(connection);
    buffer[count] = 0;
    struct json_object *reply = decode(buffer, (size_t)count);
    if (!json_object_get_boolean(field(reply, "ok", json_type_boolean))) {
        struct json_object *detail = NULL;
        if (json_object_object_get_ex(reply, "detail", &detail) && json_object_is_type(detail, json_type_string))
            fprintf(stderr, "policy service: %.2048s\n", json_object_get_string(detail));
        fail("policy service rejected this launch");
    }
    return reply;
}
static void exact_label(const char *boot, const char *work) {
    char actual[512], expected[512], reverse[512];
    FILE *stream = fopen("/proc/self/attr/current", "re");
    if (!stream || !fgets(actual, sizeof(actual), stream)) fail("kernel label");
    fclose(stream);
    actual[strcspn(actual, "\n")] = 0;
    if (snprintf(expected, sizeof(expected), "%s//&%s (enforce)", boot, work) >= (int)sizeof(expected) ||
        snprintf(reverse, sizeof(reverse), "%s//&%s (enforce)", work, boot) >= (int)sizeof(reverse) ||
        (strcmp(actual, expected) && strcmp(actual, reverse))) fail("exact retained enforcing stack");
}
static void inner(const char *number, const char *launch) {
    char *end;
    long source = strtol(number, &end, 10);
    if (!*number || *end || source < 3 || source >= 1048576 ||
        fcntl((int)source, F_GET_SEALS) != (F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL))
        fail("immutable inner handoff");
    struct stat info;
    if (fstat((int)source, &info) || info.st_size <= 0 || info.st_size > MAX_HANDOFF)
        fail("bounded manifest");
    char *raw = calloc((size_t)info.st_size + 1, 1);
    if (!raw || pread((int)source, raw, (size_t)info.st_size, 0) != info.st_size) fail("manifest read");
    struct json_object *manifest = decode(raw, (size_t)info.st_size);
    free(raw);
    struct json_object *roots = field(manifest, "roots", json_type_array);
    struct morphz_mounts mounts = {.cwd = string(manifest, "cwd"), .count = json_object_array_length(roots)};
    if (!mounts.count || mounts.count > MORPHZ_MAX_ROOTS) fail("inner root bound");
    for (size_t i = 0; i < mounts.count; ++i) {
        struct json_object *root = json_object_array_get_idx(roots, i);
        mounts.roots[i] = (struct morphz_root){.path = string(root, "path"), .fd = -1,
            .writable = json_object_get_boolean(field(root, "writable", json_type_boolean)),
            .device = (dev_t)json_object_get_uint64(field(root, "device", json_type_int)),
            .inode = (ino_t)json_object_get_uint64(field(root, "inode", json_type_int))};
    }
    int admission = json_object_get_int(field(manifest, "admission_fd", json_type_int));
    if (admission < 3 || admission == source || morphz_verify_mounted_roots(&mounts))
        fail("mounted object boundary");
    if (aa_stack_profile(string(manifest, "work"))) fail("work stack");
    exact_label(string(manifest, "bootstrap"), string(manifest, "work"));
    if (morphz_close_extra_fds(admission)) fail("host capability closure");
    int unexpected;
    exchange(admission, request("admit", launch), &unexpected);
    if (unexpected != -1) fail("admission returned a capability");
    // Only now may user-selected environment and command text become active.
    // The static launcher and distribution bwrap never load user-supplied code.
    struct json_object *environment = field(manifest, "environment", json_type_array);
    size_t count = json_object_array_length(environment);
    if (count > 32768) fail("environment count");
    char **values = calloc(count + 1, sizeof(char *));
    if (!values) fail("environment allocation");
    for (size_t i = 0; i < count; ++i) {
        struct json_object *item = json_object_array_get_idx(environment, i);
        if (!json_object_is_type(item, json_type_string)) fail("environment type");
        values[i] = (char *)json_object_get_string(item);
        if (!strchr(values[i], '=') || (size_t)json_object_get_string_len(item) != strlen(values[i]))
            fail("environment entry");
    }
    char *arguments[] = {"/bin/sh", "-c", (char *)string(manifest, "command"), NULL};
    execve(arguments[0], arguments, values);
    fail("work shell exec");
}

int main(int argc, char **argv) {
    if (morphz_unprivileged()) fail("launcher must remain unprivileged");
    if (argc == 4 && !strcmp(argv[1], "--inner")) inner(argv[2], argv[3]);
    if (argc != 4 || strcmp(argv[1], "--launch") || strlen(argv[2]) != 32 ||
        strspn(argv[2], "0123456789abcdef") != 32) fail("launch arguments");
    char executable[PATH_MAX];
    ssize_t executable_size = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
    if (executable_size < 1 || executable_size >= (ssize_t)sizeof(executable) - 1) fail("installed entry");
    executable[executable_size] = 0;
    int descriptor;
    struct json_object *claim = exchange(connect_service(CONTROL), request("claim", argv[2]), &descriptor);
    if (descriptor < 3 || write(descriptor, "0", 1) != 1) fail("self lifetime join");
    close(descriptor);
    struct json_object *policy = field(claim, "policy", json_type_object);
    struct morphz_mounts mounts = {.cwd = string(policy, "cwd")};
    for (int writable = 0; writable < 2; ++writable) {
        struct json_object *paths = field(policy, writable ? "write_roots" : "read_roots", json_type_array);
        for (size_t i = 0; i < json_object_array_length(paths); ++i) {
            struct json_object *path = json_object_array_get_idx(paths, i);
            if (mounts.count >= MORPHZ_MAX_ROOTS || !json_object_is_type(path, json_type_string)) fail("root bound");
            mounts.roots[mounts.count++] = (struct morphz_root){
                .path = json_object_get_string(path), .writable = writable, .fd = -1};
        }
    }
    if (morphz_pin_roots(&mounts)) fail("non-root directory pins");
    struct json_object *bind = request("bind_roots", argv[2]), *fds = json_object_new_array();
    for (size_t i = 0; i < mounts.count; ++i) json_object_array_add(fds, json_object_new_int(mounts.roots[i].fd));
    json_object_object_add(bind, "descriptors", fds);
    struct json_object *bound = exchange(connect_service(CONTROL), bind, &descriptor);
    if (descriptor != -1) fail("unexpected bound capability");
    int admission = connect_service(string(claim, "admission_socket"));
    struct json_object *manifest = json_object_new_object(), *environment = json_object_new_array();
    for (size_t i = 0; environ[i]; ++i) {
        if (i >= 32768) fail("environment bound");
        json_object_array_add(environment, json_object_new_string(environ[i]));
    }
    json_object_object_add(manifest, "environment", environment);
    json_object_object_add(manifest, "command", json_object_new_string(argv[3]));
    json_object_object_add(manifest, "roots", json_object_get(field(bound, "roots", json_type_array)));
    for (const char **key = (const char *[]){"bootstrap", "work", NULL}; *key; ++key)
        json_object_object_add(manifest, *key, json_object_get(field(claim, *key, json_type_string)));
    json_object_object_add(manifest, "cwd", json_object_get(field(policy, "cwd", json_type_string)));
    json_object_object_add(manifest, "admission_fd", json_object_new_int(admission));
    const char *raw = json_object_to_json_string_ext(manifest, JSON_C_TO_STRING_PLAIN);
    int source = memfd_create("morphz-work-handoff", MFD_CLOEXEC | MFD_ALLOW_SEALING);
    if (source < 0 || strlen(raw) > MAX_HANDOFF || write(source, raw, strlen(raw)) != (ssize_t)strlen(raw) ||
        fcntl(source, F_ADD_SEALS, F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL))
        fail("sealed command handoff");
    pid_t child = fork();
    if (child < 0) fail("namespace worker fork");
    if (!child) {
        const char *hidden[8];
        struct json_object *paths = field(policy, "hidden_roots", json_type_array);
        size_t count = json_object_array_length(paths);
        if (count > 8) fail("hidden root bound");
        for (size_t i = 0; i < count; ++i) hidden[i] = json_object_get_string(json_object_array_get_idx(paths, i));
        struct morphz_argv arguments = {0};
        if (morphz_build_bwrap(&mounts, hidden, count, !strcmp(string(policy, "mode"), "pty"),
                               !strcmp(string(policy, "network"), "allow"), &arguments)) fail("mount plan");
        char handoff[32];
        snprintf(handoff, sizeof(handoff), "%d", source);
        const char *entry[] = {"--", executable, "--inner", handoff, argv[2]};
        for (size_t i = 0; i < sizeof(entry) / sizeof(entry[0]); ++i)
            if (morphz_arg(&arguments, entry[i])) fail("inner arguments");
        for (size_t i = 0; i < mounts.count; ++i)
            if (fcntl(mounts.roots[i].fd, F_SETFD, 0)) fail("root handoff");
        if (fcntl(source, F_SETFD, 0) || fcntl(admission, F_SETFD, 0) ||
            aa_change_profile(string(claim, "bootstrap")) || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0))
            fail("trusted bootstrap entry");
        char *clean[] = {"PATH=/usr/bin:/bin", "LANG=C.UTF-8", NULL};
        execve(arguments.values[0], arguments.values, clean);
        fail("distribution Bubblewrap exec");
    }
    close(source);
    close(admission);
    // Keep the original approved directory objects alive until all admission
    // checks finish. Lifetime reclamation belongs to the service, not this PID.
    int status;
    while (waitpid(child, &status, 0) < 0) if (errno != EINTR) fail("namespace worker wait");
    morphz_close_roots(&mounts);
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
    fail("unexpected worker status");
}
