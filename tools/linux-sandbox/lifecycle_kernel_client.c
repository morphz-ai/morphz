#define _GNU_SOURCE
/* Fixed CI peers, not an installed command launcher. Distinct root-owned
 * Runtime and launcher binaries exercise the real service registration roles. */
#include "mounts.h"
#include <json-c/json.h>
#include <sys/apparmor.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void fail(const char *message) {
    fprintf(stderr, "fixed lifetime peer refused: %s (errno=%d)\n", message, errno);
    exit(78);
}
static const char *string(struct json_object *object, const char *key) {
    struct json_object *value = NULL;
    if (!json_object_object_get_ex(object, key, &value) || !json_object_is_type(value, json_type_string)) fail(key);
    return json_object_get_string(value);
}
static int connect_service(const char *path) {
    int connection = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
    struct sockaddr_un address = {.sun_family = AF_UNIX};
    if (connection < 0 || strlen(path) >= sizeof(address.sun_path)) fail("control address");
    strcpy(address.sun_path, path);
    if (connect(connection, (struct sockaddr *)&address, sizeof(address))) fail("control connection");
    struct ucred server;
    socklen_t size = sizeof(server);
    if (getsockopt(connection, SOL_SOCKET, SO_PEERCRED, &server, &size) || server.uid != 0) fail("service identity");
    return connection;
}
static struct json_object *exchange_connection(int connection, struct json_object *request, int *received) {
    const char *raw = json_object_to_json_string_ext(request, JSON_C_TO_STRING_PLAIN);
    if (send(connection, raw, strlen(raw), MSG_NOSIGNAL) != (ssize_t)strlen(raw)) fail("request");
    char buffer[262145], ancillary[CMSG_SPACE(sizeof(int) * 4)];
    struct iovec vector = {.iov_base = buffer, .iov_len = sizeof(buffer) - 1};
    struct msghdr message = {.msg_iov = &vector, .msg_iovlen = 1,
                            .msg_control = ancillary, .msg_controllen = sizeof(ancillary)};
    ssize_t count = recvmsg(connection, &message, MSG_CMSG_CLOEXEC);
    if (count <= 0 || message.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) fail("bounded reply");
    *received = -1;
    for (struct cmsghdr *item = CMSG_FIRSTHDR(&message); item; item = CMSG_NXTHDR(&message, item)) {
        if (item->cmsg_level != SOL_SOCKET || item->cmsg_type != SCM_RIGHTS ||
            item->cmsg_len != CMSG_LEN(sizeof(int)) || *received != -1) fail("reply capabilities");
        memcpy(received, CMSG_DATA(item), sizeof(int));
    }
    buffer[count] = 0;
    close(connection);
    struct json_object *result = json_tokener_parse(buffer), *ok = NULL;
    if (!result || !json_object_object_get_ex(result, "ok", &ok)) fail("reply syntax");
    return result;
}
static struct json_object *exchange(const char *path, struct json_object *request, int *received) {
    return exchange_connection(connect_service(path), request, received);
}
static struct json_object *request(const char *operation, const char *launch) {
    struct json_object *value = json_object_new_object();
    json_object_object_add(value, "op", json_object_new_string(operation));
    if (launch) json_object_object_add(value, "launch", json_object_new_string(launch));
    return value;
}
static int succeeded(struct json_object *value) {
    struct json_object *ok = NULL;
    return json_object_object_get_ex(value, "ok", &ok) && json_object_get_boolean(ok);
}

#ifdef MORPHZ_TEST_RUNTIME
int main(int argc, char **argv) {
    if (argc != 8 || morphz_unprivileged()) fail("fixed Runtime arguments");
    struct json_object *policy = json_object_from_file(argv[2]);
    if (!policy) fail("synthetic policy file");
    struct json_object *value = request("register", NULL);
    json_object_object_add(value, "policy", policy);
    int descriptor;
    struct json_object *reply = exchange(argv[1], value, &descriptor);
    if (!succeeded(reply)) {
        puts("{\"rejected\":true}");
        return !strcmp(argv[4], "rogue") ? 0 : 78;
    }
    if (descriptor < 0 || !strcmp(argv[4], "rogue")) fail("registration authority");
    struct stat receipt;
    if (fstat(descriptor, &receipt) || !S_ISFIFO(receipt.st_mode) || receipt.st_uid != 0 ||
        (fcntl(descriptor, F_GETFL) & O_ACCMODE) != O_RDONLY) fail("one-way root-owned startup receipt");
    const char *launch = string(reply, "launch");
    printf("{\"registered\":\"%s\"}\n", launch);
    fflush(stdout);
    pid_t child = fork();
    if (child < 0) fail("launcher fork");
    if (!child) {
        close(descriptor);
        execl(argv[3], argv[3], argv[1], launch, argv[4], argv[5], argv[6], argv[7], (char *)NULL);
        fail("fixed launcher exec");
    }
    if (!strncmp(argv[4], "mounted-", 8)) {
        struct pollfd pending = {.fd = descriptor, .events = POLLIN | POLLHUP};
        if (poll(&pending, 1, 8000) != 1) fail("private startup receipt timeout");
        unsigned char byte = 0;
        ssize_t size = read(descriptor, &byte, 1);
        if (!strcmp(argv[4], "mounted-normal") ? size != 1 || byte != 1 : size != 0)
            fail("service receipt does not match real admission outcome");
        fprintf(stderr, "private startup receipt verified: %s\n", size == 1 ? "admitted" : "refused");
    }
    close(descriptor);
    int status;
    if (waitpid(child, &status, 0) != child || !WIFEXITED(status)) fail("launcher exit");
    return WEXITSTATUS(status);
}
#else
static struct json_object *field(struct json_object *object, const char *key, enum json_type kind) {
    struct json_object *value = NULL;
    if (!json_object_object_get_ex(object, key, &value) || !json_object_is_type(value, kind)) fail(key);
    return value;
}
static void exact_label(const char *boot, const char *work) {
    char actual[512], expected[512], reverse[512];
    FILE *stream = fopen("/proc/self/attr/current", "re");
    if (!stream || !fgets(actual, sizeof(actual), stream)) fail("kernel label");
    fclose(stream);
    actual[strcspn(actual, "\n")] = 0;
    if (snprintf(expected, sizeof(expected), "%s//&%s (enforce)", boot, work) >= (int)sizeof(expected) ||
        snprintf(reverse, sizeof(reverse), "%s//&%s (enforce)", work, boot) >= (int)sizeof(reverse) ||
        (strcmp(actual, expected) && strcmp(actual, reverse))) fail("exact retained stack");
}
static int extras(void) {
    DIR *directory = opendir("/proc/self/fd");
    if (!directory) fail("descriptor inventory");
    int own = dirfd(directory), result = 0;
    struct dirent *item;
    while ((item = readdir(directory))) {
        char *end;
        long value = strtol(item->d_name, &end, 10);
        if (*item->d_name && !*end && value > 2 && value != own) result++;
    }
    closedir(directory);
    return result;
}
static void mounted_outer(char **argv, struct json_object *claim) {
    struct json_object *policy = field(claim, "policy", json_type_object);
    struct morphz_mounts mounts = {.cwd = string(policy, "cwd")};
    struct json_object *descriptors = json_object_new_array();
    for (int writable = 0; writable < 2; writable++) {
        struct json_object *paths = field(policy, writable ? "write_roots" : "read_roots", json_type_array);
        for (size_t i = 0; i < json_object_array_length(paths); ++i) {
            if (mounts.count >= MORPHZ_MAX_ROOTS) fail("mounted root bound");
            struct json_object *path = json_object_array_get_idx(paths, i);
            if (!json_object_is_type(path, json_type_string)) fail("root path");
            mounts.roots[mounts.count++] = (struct morphz_root){
                .path = json_object_get_string(path), .writable = writable, .fd = -1};
        }
    }
    if (morphz_pin_roots(&mounts)) fail("non-root object pins");
    for (size_t i = 0; i < mounts.count; ++i)
        json_object_array_add(descriptors, json_object_new_int(mounts.roots[i].fd));
    struct json_object *bind = request("bind_roots", argv[2]);
    json_object_object_add(bind, "descriptors", descriptors);
    int unexpected;
    struct json_object *bound = exchange(argv[1], bind, &unexpected);
    if (!succeeded(bound) || unexpected != -1) fail("service object binding");
    // Authenticate root before entering the single-UID user namespace, where
    // the host's root UID is intentionally unmapped. Only the trusted inner
    // executable inherits this exact channel; the server checks its real
    // per-message pidfd, not the outer connection PID as the work identity.
    int admission = connect_service(string(claim, "admission_socket"));
    struct json_object *manifest = json_object_new_object();
    json_object_object_add(manifest, "roots", json_object_get(field(bound, "roots", json_type_array)));
    json_object_object_add(manifest, "bootstrap", json_object_get(field(claim, "bootstrap", json_type_string)));
    json_object_object_add(manifest, "work", json_object_get(field(claim, "work", json_type_string)));
    json_object_object_add(manifest, "cwd", json_object_get(field(policy, "cwd", json_type_string)));
    json_object_object_add(manifest, "mode", json_object_new_string(argv[3]));
    json_object_object_add(manifest, "admission_fd", json_object_new_int(admission));
    int source = memfd_create("morphz-admission-contract", MFD_CLOEXEC | MFD_ALLOW_SEALING);
    const char *raw = json_object_to_json_string_ext(manifest, JSON_C_TO_STRING_PLAIN);
    if (source < 0 || write(source, raw, strlen(raw)) != (ssize_t)strlen(raw) ||
        fcntl(source, F_ADD_SEALS, F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL))
        fail("sealed handoff");
    pid_t child = fork();
    if (child < 0) fail("mounted child");
    if (child == 0) {
        const char *hidden[] = {"/home", "/tmp"};
        struct morphz_argv arguments = {0};
        if (morphz_build_bwrap(&mounts, hidden, 2, 0, 0, &arguments)) fail("actual namespace arguments");
        char handoff[32];
        snprintf(handoff, sizeof(handoff), "%d", source);
        const char *inner[] = {"--", argv[0], string(claim, "admission_socket"), argv[2],
                              "mounted-inner", handoff, argv[5], argv[6]};
        for (size_t i = 0; i < sizeof(inner) / sizeof(inner[0]); ++i)
            if (morphz_arg(&arguments, inner[i])) fail("fixed inner entry");
        for (size_t i = 0; i < mounts.count; ++i)
            if (fcntl(mounts.roots[i].fd, F_SETFD, 0)) fail("root handoff");
        if (fcntl(source, F_SETFD, 0) || fcntl(admission, F_SETFD, 0) ||
            aa_change_profile(string(claim, "bootstrap")) ||
            prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) fail("trusted setup boundary");
        execv(arguments.values[0], arguments.values);
        fail("distribution bwrap");
    }
    close(source);
    close(admission);
    int status;
    if (waitpid(child, &status, 0) != child || !WIFEXITED(status)) fail("mounted entry exit");
    morphz_close_roots(&mounts);
    exit(WEXITSTATUS(status));
}
static struct json_object *mounted_inner(char **argv) {
    char *end;
    long source = strtol(argv[4], &end, 10);
    if (!*argv[4] || *end || source < 3 || source >= 1048576 ||
        fcntl((int)source, F_GET_SEALS) != (F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL))
        fail("immutable inner handoff");
    struct stat metadata;
    if (fstat((int)source, &metadata) || metadata.st_size <= 0 || metadata.st_size > 262144)
        fail("bounded manifest");
    char *raw = calloc((size_t)metadata.st_size + 1, 1);
    if (!raw || pread((int)source, raw, (size_t)metadata.st_size, 0) != metadata.st_size) fail("handoff read");
    struct json_object *manifest = json_tokener_parse(raw);
    free(raw);
    if (!manifest) fail("handoff syntax");
    struct json_object *roots = field(manifest, "roots", json_type_array);
    struct morphz_mounts mounts = {.cwd = string(manifest, "cwd"), .count = json_object_array_length(roots)};
    if (mounts.count > MORPHZ_MAX_ROOTS) fail("inner root bound");
    for (size_t i = 0; i < mounts.count; ++i) {
        struct json_object *root = json_object_array_get_idx(roots, i);
        mounts.roots[i] = (struct morphz_root){.path = string(root, "path"), .fd = -1,
            .writable = json_object_get_boolean(field(root, "writable", json_type_boolean)),
            .device = (dev_t)json_object_get_uint64(field(root, "device", json_type_int)),
            .inode = (ino_t)json_object_get_uint64(field(root, "inode", json_type_int))};
    }
    const char *mode = string(manifest, "mode");
    int admission = json_object_get_int(field(manifest, "admission_fd", json_type_int));
    if (admission < 3 || admission == source) fail("private admission handoff");
    if (morphz_finalize_mounts(&mounts)) fail("recursive read-only mount boundary");
    if (morphz_verify_mounted_roots(&mounts)) fail("inner actual object identity");
    if (strcmp(mode, "mounted-no-stack") && aa_stack_profile(string(manifest, "work"))) fail("work stacking");
    if (strcmp(mode, "mounted-leak") && morphz_close_extra_fds(admission)) fail("inner closure");
    int descriptor;
    struct json_object *reply = exchange_connection(admission, request("admit", argv[2]), &descriptor);
    if (!succeeded(reply)) {
        fprintf(stderr, "admission result: %s\n", json_object_to_json_string_ext(reply, JSON_C_TO_STRING_PLAIN));
        puts("{\"admission_rejected\":true}");
        exit(!strcmp(mode, "mounted-normal") ? 78 : 0);
    }
    if (descriptor != -1 || strcmp(mode, "mounted-normal")) fail("negative work unexpectedly admitted");
    // Point the fixed worker at the protected path in the frozen workspace.
    char *protected = NULL;
    if (asprintf(&protected, "%s/future.env", mounts.cwd) < 0) fail("protected fixture path");
    argv[4] = protected;
    return manifest;
}
int main(int argc, char **argv) {
    if (argc != 7) fail("fixed launcher arguments");
    int descriptor;
    int mounted = !strcmp(argv[3], "mounted-inner");
    struct json_object *reply;
    if (mounted) {
        reply = mounted_inner(argv);
        goto admitted;
    }
    if (morphz_unprivileged()) fail("fixed unprivileged outer launcher");
    reply = exchange(argv[1], request("claim", argv[2]), &descriptor);
    if (!succeeded(reply) || descriptor < 0) fail("one-use claim");
    if (!strcmp(argv[3], "held") || !strcmp(argv[3], "held-restart")) {
        printf("{\"held\":true,\"pid\":%ld}\n", (long)getpid());
        fflush(stdout);
        if (getchar() != 'G') fail("held-capability barrier");
        errno = 0;
        ssize_t count = write(descriptor, "0", 1);
        int problem = errno;
        close(descriptor);
        printf("{\"stale_join_refused\":%s,\"errno\":%d}\n",
               count == -1 && problem == ENODEV ? "true" : "false", problem);
        return count == -1 && problem == ENODEV ? 0 : 78;
    }
    /* Kernel migration uses this opened capability's credentials, but literal
     * zero identifies the writing thread group atomically, never a stale PID. */
    if (write(descriptor, "0", 1) != 1) fail("self cgroup join");
    close(descriptor);
    if (!strncmp(argv[3], "mounted-", 8)) mounted_outer(argv, reply);
    const char *boot = string(reply, "bootstrap"), *work = string(reply, "work");
    if (aa_change_profile(boot) || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || aa_stack_profile(work))
        fail("fixed synthetic work entry");
    exact_label(boot, work);
    if (morphz_unprivileged() || morphz_close_extra_fds(-1)) fail("pre-work closure");
admitted:
    ;
    const char *active_boot = string(reply, "bootstrap"), *active_work = string(reply, "work");
    exact_label(active_boot, active_work);
    pid_t background = mounted ? 0 : fork();
    if (background < 0) fail("fixed background child");
    if (background) return 0;  /* both launcher and Runtime now exit */
    printf("{\"ready\":true,\"pid\":%ld,\"extra_fds\":%d}\n", (long)getpid(), extras());
    fflush(stdout);
    char line[32];
    while (fgets(line, sizeof(line), stdin)) {
        if (!strcmp(line, "exit\n")) return 0;
        if (strcmp(line, "probe\n")) fail("unregistered synthetic operation");
        errno = 0;
        int secret = open(argv[4], O_RDONLY | O_CLOEXEC);
        int problem = errno;
        if (secret >= 0) close(secret);
        int allowed = open(argv[5], O_WRONLY | O_APPEND | O_CLOEXEC);
        int wrote = allowed >= 0 && write(allowed, "worker\n", 7) == 7;
        if (allowed >= 0) close(allowed);
        int escape = open(argv[6], O_WRONLY | O_CLOEXEC);
        int escape_error = errno;
        if (escape >= 0) close(escape);
        exact_label(active_boot, active_work);
        printf("{\"protected_denied\":%s,\"errno\":%d,\"allowed_write\":%s,"
               "\"escape_denied\":%s,\"extra_fds\":%d}\n",
               secret < 0 && (problem == EACCES || problem == EPERM) ? "true" : "false", problem,
               wrote ? "true" : "false",
               escape < 0 && (escape_error == EACCES || escape_error == EPERM) ? "true" : "false", extras());
        fflush(stdout);
    }
    return 0;
}
#endif
