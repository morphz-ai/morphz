#define _GNU_SOURCE
/* Isolated trusted entry: fixed outer/inner chain, not a general privileged runner.
 * Built only in the proposed Ubuntu workflow with system json-c/libapparmor.
 * Never setuid. No shell text, profile override, or arbitrary bwrap argv input.
 */
#include <sys/apparmor.h>
#include <json-c/json.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/prctl.h>
#include <sys/time.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MANIFEST_FD 3
#define CONTROL_FD 4
static struct stat manifest_metadata;

static void fail(const char *why) {
    fprintf(stderr, "dynamic entry refused: %s (errno=%d)\n", why, errno);
    exit(78);
}
static struct json_object *field(struct json_object *obj, const char *key,
                                enum json_type type) {
    struct json_object *value = NULL;
    if (!json_object_object_get_ex(obj, key, &value) ||
        !json_object_is_type(value, type)) fail(key);
    return value;
}
static const char *text(struct json_object *obj, const char *key) {
    return json_object_get_string(field(obj, key, json_type_string));
}
static void exact_label(const char *profile) {
    char expected[256], actual[512];
    if (snprintf(expected, sizeof(expected), "%s (enforce)", profile) >= (int)sizeof(expected))
        fail("profile length");
    FILE *stream = fopen("/proc/self/attr/current", "r");
    if (!stream || !fgets(actual, sizeof(actual), stream)) fail("read label");
    fclose(stream);
    actual[strcspn(actual, "\n")] = 0;
    if (strcmp(expected, actual)) fail("not the exact enforcing label");
}
static void hex_token(const char *value) {
    if (strlen(value) != 32 || strspn(value, "0123456789abcdef") != 32)
        fail("fixed launch identifier");
}
static void bootstrap_only(void) {
    /* An untrusted workload may exec this file, but it retains the work stack.
     * Reject it before reading any caller-supplied FD or descriptor fields. */
    char actual[512];
    FILE *stream = fopen("/proc/self/attr/current", "r");
    if (!stream || !fgets(actual, sizeof(actual), stream)) fail("read bootstrap label");
    fclose(stream);
    actual[strcspn(actual, "\n")] = 0;
    const char *prefix = "morphz_dynamic_";
    size_t at = strlen(prefix);
    if (strncmp(actual, prefix, at) ||
        strlen(actual) != at + 32 + 1 + 32 + strlen("_boot (enforce)") ||
        strspn(actual + at, "0123456789abcdef") != 32 ||
        actual[at + 32] != '_' ||
        strspn(actual + at + 33, "0123456789abcdef") != 32 ||
        strcmp(actual + at + 65, "_boot (enforce)"))
        fail("requires one exact bootstrap-only enforcing label");
}
static void descriptor_labels(struct json_object *obj) {
    const char *run = text(obj, "run_id"), *launch = text(obj, "launch_id");
    char boot[256], work[256];
    hex_token(run); hex_token(launch);
    if (snprintf(boot, sizeof(boot), "morphz_dynamic_%s_%s_boot", run, launch) >= (int)sizeof(boot) ||
        snprintf(work, sizeof(work), "morphz_dynamic_%s_%s_work", run, launch) >= (int)sizeof(work) ||
        strcmp(boot, text(obj, "bootstrap")) || strcmp(work, text(obj, "profile")))
        fail("descriptor labels are not derived from this launch");
    exact_label(boot);
}
static const char *exact_stack(struct json_object *obj) {
    static char result[512];
    char reverse[512], actual[600], first[600], second[600];
    const char *boot = text(obj, "bootstrap"), *work = text(obj, "profile");
    if (snprintf(result, sizeof(result), "%s//&%s", boot, work) >= (int)sizeof(result) ||
        snprintf(reverse, sizeof(reverse), "%s//&%s", work, boot) >= (int)sizeof(reverse) ||
        snprintf(first, sizeof(first), "%s (enforce)", result) >= (int)sizeof(first) ||
        snprintf(second, sizeof(second), "%s (enforce)", reverse) >= (int)sizeof(second))
        fail("stack label length");
    FILE *stream = fopen("/proc/self/attr/current", "r");
    if (!stream || !fgets(actual, sizeof(actual), stream)) fail("read stack");
    fclose(stream);
    actual[strcspn(actual, "\n")] = 0;
    if (!strcmp(actual, second))
        strcpy(result, reverse);
    else if (strcmp(actual, first))
        fail("not the exact two-component enforcing stack");
    return result;
}
static void security_state(void) {
    FILE *stream = fopen("/proc/self/status", "r");
    if (!stream) fail("status");
    char line[512];
    int nnp = 0, effective = 0, permitted = 0, inherited = 0, ambient = 0;
    while (fgets(line, sizeof(line), stream)) {
        unsigned long long bits;
        int value;
        if (sscanf(line, "NoNewPrivs: %d", &value) == 1) nnp = value == 1;
        if (sscanf(line, "CapEff: %llx", &bits) == 1) effective = bits == 0;
        if (sscanf(line, "CapPrm: %llx", &bits) == 1) permitted = bits == 0;
        if (sscanf(line, "CapInh: %llx", &bits) == 1) inherited = bits == 0;
        if (sscanf(line, "CapAmb: %llx", &bits) == 1) ambient = bits == 0;
    }
    fclose(stream);
    if (!nnp || !effective || !permitted || !inherited || !ambient) fail("privileges were not dropped");
}
static struct json_object *manifest_fd(int fd, int host_owner, const char *file) {
    struct stat info;
    int flags = fcntl(fd, F_GETFL);
    if (fd < 0 || flags < 0 || (flags & O_ACCMODE) != O_RDONLY ||
        fstat(fd, &info) || !S_ISREG(info.st_mode) || (info.st_mode & 0022) ||
        info.st_size <= 0 || info.st_size > 65536)
        fail("immutable read-only manifest FD");
    /* Host root is checked only before user namespaces. No overflow-owner case. */
    if (host_owner && info.st_uid != 0) fail("immutable root manifest");
    manifest_metadata = info;
    size_t size = (size_t)info.st_size, have = 0;
    char *raw = calloc(size + 1, 1);
    if (!raw) fail("allocation");
    while (have < size) {
        ssize_t n = pread(fd, raw + have, size - have, (off_t)have);
        if (n <= 0) fail("manifest read");
        have += (size_t)n;
    }
    struct json_tokener *parser = json_tokener_new();
    if (!parser) fail("JSON parser allocation");
    json_tokener_set_flags(parser, JSON_TOKENER_STRICT | JSON_TOKENER_VALIDATE_UTF8);
    struct json_object *obj = json_tokener_parse_ex(parser, raw, (int)size);
    if (json_tokener_get_error(parser) != json_tokener_success ||
        json_tokener_get_parse_end(parser) != size ||
        !obj || !json_object_is_type(obj, json_type_object)) fail("manifest JSON");
    json_tokener_free(parser);
    free(raw);
    if (json_object_object_length(obj) != 17) fail("manifest exact field count");
    if (json_object_get_int(field(obj, "abi", json_type_int)) != 1) fail("ABI");
    int64_t uid = json_object_get_int64(field(obj, "uid", json_type_int));
    if (uid <= 0 || uid > UINT_MAX || getuid() != (uid_t)uid || geteuid() != (uid_t)uid)
        fail("non-root workload UID");
    if (file && strcmp(text(obj, "manifest"), file)) fail("manifest self identity");
    (void)text(obj, "manifest");
    const char *mode = text(obj, "mode"), *network = text(obj, "network");
    if ((strcmp(mode, "exec") && strcmp(mode, "pty")) ||
        (strcmp(network, "allow") && strcmp(network, "deny"))) fail("mode/network");
    struct json_object *roots = field(obj, "roots", json_type_array);
    if (json_object_array_length(roots) < 1 || json_object_array_length(roots) > 4)
        fail("roots bound");
    (void)field(obj, "protected", json_type_array);
    (void)text(obj, "policy_hash"); (void)text(obj, "bootstrap");
    (void)text(obj, "profile"); (void)text(obj, "stage");
    (void)text(obj, "entry"); (void)text(obj, "worker");
    (void)text(obj, "control"); (void)text(obj, "cwd");
    descriptor_labels(obj);
    return obj;
}
static void verify_roots(struct json_object *obj, int keep_open) {
    struct json_object *roots = field(obj, "roots", json_type_array);
    for (size_t i = 0; i < json_object_array_length(roots); i++) {
        struct json_object *root = json_object_array_get_idx(roots, i);
        if (!json_object_is_type(root, json_type_object) ||
            json_object_object_length(root) != 4) fail("root fields");
        const char *access = text(root, "access");
        if (strcmp(access, "read") && strcmp(access, "write")) fail("root access");
        int fd = open(text(root, "path"), O_PATH | O_NOFOLLOW | O_DIRECTORY);
        struct stat info;
        if (fd < 0 || fstat(fd, &info) ||
            (uint64_t)info.st_dev != json_object_get_uint64(field(root, "dev", json_type_int)) ||
            (uint64_t)info.st_ino != json_object_get_uint64(field(root, "ino", json_type_int)))
            fail("root identity changed");
        if (!keep_open) close(fd);
    }
}
static char *argv_buf[160];
static size_t argv_len;
static void arg(const char *value) {
    if (argv_len + 1 >= sizeof(argv_buf) / sizeof(argv_buf[0])) fail("argv bound");
    argv_buf[argv_len++] = (char *)value;
    argv_buf[argv_len] = NULL;
}
static void pair(const char *a, const char *b) { arg(a); arg(b); }
static void bind_mount(const char *flag, const char *path) { arg(flag); arg(path); arg(path); }
static void join(char *out, size_t count, const char *root, const char *suffix) {
    if (snprintf(out, count, "%s/%s", root, suffix) >= (int)count) fail("path length");
}
static void startup_diagnostic(void) {
    /* Read-only evidence for pre-admission startup failures; no state changes. */
    struct json_object *record = json_object_new_object();
    json_object_object_add(record, "phase", json_object_new_string("before_fixed_bwrap"));
    json_object_object_add(record, "uid", json_object_new_int64(getuid()));
    json_object_object_add(record, "euid", json_object_new_int64(geteuid()));
    json_object_object_add(record, "gid", json_object_new_int64(getgid()));
    json_object_object_add(record, "dumpable", json_object_new_int(prctl(PR_GET_DUMPABLE, 0, 0, 0, 0)));
    struct stat metadata;
    if (stat("/proc/self/uid_map", &metadata) == 0) {
        json_object_object_add(record, "uid_map_owner", json_object_new_int64(metadata.st_uid));
        json_object_object_add(record, "uid_map_mode", json_object_new_int(metadata.st_mode & 07777));
    } else {
        json_object_object_add(record, "uid_map_stat_errno", json_object_new_int(errno));
    }
    FILE *stream = fopen("/proc/self/status", "r");
    char line[512];
    if (stream) {
        while (fgets(line, sizeof(line), stream)) {
            if (!strncmp(line, "Cap", 3) || !strncmp(line, "NoNewPrivs:", 11) ||
                !strncmp(line, "Uid:", 4) || !strncmp(line, "Gid:", 4)) {
                char *value = strchr(line, ':');
                if (value) {
                    *value++ = 0;
                    value += strspn(value, " \t");
                    value[strcspn(value, "\n")] = 0;
                    json_object_object_add(record, line, json_object_new_string(value));
                }
            }
        }
        fclose(stream);
    }
    fprintf(stderr, "DYNAMIC_ENTRY_DIAGNOSTIC %s\n",
            json_object_to_json_string_ext(record, JSON_C_TO_STRING_PLAIN));
    json_object_put(record);
}
static void send_startup(int fd, struct json_object *obj, const char *phase) {
    struct json_object *record = json_object_new_object();
    const char *keys[] = {"run_id", "launch_id", "policy_hash", "profile"};
    for (size_t i = 0; i < sizeof(keys) / sizeof(keys[0]); i++)
        json_object_object_add(record, keys[i], json_object_new_string(text(obj, keys[i])));
    json_object_object_add(record, "uid", json_object_new_int64(getuid()));
    json_object_object_add(record, "phase", json_object_new_string(phase));
    struct json_object *identity = json_object_new_object();
    json_object_object_add(identity, "dev", json_object_new_uint64(manifest_metadata.st_dev));
    json_object_object_add(identity, "ino", json_object_new_uint64(manifest_metadata.st_ino));
    json_object_object_add(identity, "size", json_object_new_int64(manifest_metadata.st_size));
    json_object_object_add(identity, "mode", json_object_new_int64(manifest_metadata.st_mode));
    json_object_object_add(identity, "access", json_object_new_int(O_RDONLY));
    json_object_object_add(record, "manifest_fd", identity);
    const char *data = json_object_to_json_string_ext(record, JSON_C_TO_STRING_PLAIN);
    size_t count = strlen(data);
    struct iovec vectors[] = {{.iov_base = (void *)data, .iov_len = count},
                              {.iov_base = "\n", .iov_len = 1}};
    struct msghdr message = {.msg_iov = vectors, .msg_iovlen = 2};
    /* SO_PASSCRED is set on the receiver before connect. Kernel credentials are
     * attached to this sender's bytes, including after bwrap forks the inner. */
    if (count >= 4096 || sendmsg(fd, &message, MSG_NOSIGNAL) != (ssize_t)count + 1)
        fail("send startup record");
    json_object_put(record);
}
static void expect_reply(int fd, const char *expected, size_t size, const char *why) {
    char reply[8];
    size_t have = 0;
    if (size > sizeof(reply)) fail("fixed reply bound");
    while (have < size) {
        ssize_t n = read(fd, reply + have, size - have);
        if (n <= 0) {
            int read_errno = errno;
            fprintf(stderr, "DYNAMIC_ENTRY_READ_FAILURE fd=%d why=%s n=%zd errno=%d eof=%d\n",
                    fd, why, n, read_errno, n == 0);
            /* Failure-only observation: determine whether the inherited handle
             * is still a socket. Never retry read, replace it with recv, or
             * allow these diagnostic calls to change the original refusal. */
            struct stat metadata = {0};
            int stat_code = fstat(fd, &metadata);
            int stat_errno = stat_code < 0 ? errno : 0;
            int socket_type = 0;
            socklen_t socket_size = sizeof(socket_type);
            int socket_code = getsockopt(fd, SOL_SOCKET, SO_TYPE, &socket_type, &socket_size);
            int socket_errno = socket_code < 0 ? errno : 0;
            fprintf(stderr,
                    "DYNAMIC_ENTRY_FAILED_FD fd=%d fstat=%d stat_errno=%d mode=%o "
                    "is_socket=%d getsockopt=%d socket_errno=%d socket_type=%d socket_size=%u\n",
                    fd, stat_code, stat_errno, (unsigned int)metadata.st_mode,
                    stat_code == 0 && S_ISSOCK(metadata.st_mode), socket_code, socket_errno,
                    socket_type, (unsigned int)socket_size);
            errno = read_errno;
            fail(why);
        }
        have += (size_t)n;
    }
    if (memcmp(reply, expected, size)) fail("admission refused");
}
static int connect_host(struct json_object *obj) {
    pid_t parent = getppid();
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0 || parent <= 1) fail("host control socket");
    struct timeval limit = {.tv_sec = 10, .tv_usec = 0};
    if (setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &limit, sizeof(limit)) ||
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &limit, sizeof(limit)))
        fail("socket timeout");
    struct sockaddr_un address = {.sun_family = AF_UNIX};
    join(address.sun_path, sizeof(address.sun_path), text(obj, "control"), "admit.sock");
    if (connect(fd, (struct sockaddr *)&address, sizeof(address))) fail("connect host control");
    struct ucred peer;
    socklen_t size = sizeof(peer);
    if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &peer, &size) || size != sizeof(peer) ||
        peer.pid != parent || getppid() != parent || peer.uid != getuid() ||
        peer.gid != getgid()) fail("control peer is not the original host parent");
    char label[128] = {0};
    size = sizeof(label) - 1;
    if (getsockopt(fd, SOL_SOCKET, SO_PEERSEC, label, &size) || size >= sizeof(label) ||
        strcmp(label, "unconfined")) fail("host controller is not the expected label");
    send_startup(fd, obj, "outer");
    expect_reply(fd, "HOST\n", 5, "host acknowledgement");
    return fd;
}
static void fixed_startup_fds(int manifest, int control) {
    /* Duplicate both above the fixed slots before replacing either; no
     * descriptor number or already-authenticated flag comes from the caller. */
    int saved_manifest = fcntl(manifest, F_DUPFD_CLOEXEC, 5);
    int saved_control = fcntl(control, F_DUPFD_CLOEXEC, 5);
    if (saved_manifest < 0 || saved_control < 0 ||
        dup2(saved_manifest, MANIFEST_FD) != MANIFEST_FD ||
        dup2(saved_control, CONTROL_FD) != CONTROL_FD)
        fail("fixed startup FD handoff");
    close(saved_manifest); close(saved_control);
    if (manifest > CONTROL_FD) close(manifest);
    if (control > CONTROL_FD) close(control);
    /* dup2 cleared CLOEXEC on exactly the two intended handoff slots. */
}
static void outer(struct json_object *obj, int manifest) {
    int control = connect_host(obj);
    fixed_startup_fds(manifest, control);
    verify_roots(obj, 1);
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) fail("NoNewPrivs");
    const char *stage = text(obj, "stage");
    char trusted[PATH_MAX], launches[PATH_MAX];
    join(trusted, sizeof(trusted), stage, "trusted");
    join(launches, sizeof(launches), stage, "launches");
    arg("/usr/bin/bwrap"); arg("--die-with-parent");
    bind_mount("--ro-bind", "/"); pair("--dev", "/dev");
    arg("--unshare-user"); arg("--unshare-pid"); arg("--unshare-ipc");
    if (!strcmp(text(obj, "network"), "deny")) arg("--unshare-net");
    pair("--proc", "/proc"); pair("--cap-drop", "ALL");
    pair("--tmpfs", "/home"); pair("--tmpfs", "/root"); pair("--tmpfs", "/tmp");
    pair("--dir", stage);
    bind_mount("--ro-bind", trusted);
    bind_mount("--ro-bind", launches);
    bind_mount("--ro-bind", text(obj, "control"));
    struct json_object *roots = field(obj, "roots", json_type_array);
    for (size_t i = 0; i < json_object_array_length(roots); i++) {
        struct json_object *root = json_object_array_get_idx(roots, i);
        bind_mount(!strcmp(text(root, "access"), "write") ? "--bind" : "--ro-bind",
             text(root, "path"));
    }
    arg("--clearenv"); pair("--setenv", "PATH"); arg("/usr/bin:/bin");
    pair("--setenv", "LANG"); arg("C.UTF-8");
    pair("--setenv", "HOME"); arg(text(obj, "cwd"));
    pair("--chdir", text(obj, "cwd"));
    if (!strcmp(text(obj, "mode"), "exec")) arg("--new-session");
    arg("--"); arg(text(obj, "entry")); arg("--inner");
    startup_diagnostic();
    execv(argv_buf[0], argv_buf);
    fail("fixed bwrap exec");
}
static void close_extra(int keep) {
    DIR *list = opendir("/proc/self/fd");
    if (!list) fail("FD enumeration");
    struct dirent *item;
    while ((item = readdir(list))) {
        char *end;
        long fd = strtol(item->d_name, &end, 10);
        if (*item->d_name && !*end && fd > 2 && fd != keep && fd != dirfd(list))
            close((int)fd);
    }
    closedir(list);
}
static void admission(struct json_object *obj) {
    send_startup(CONTROL_FD, obj, "inner");
    expect_reply(CONTROL_FD, "GO\n", 3, "admission acknowledgement");
    close(CONTROL_FD);
}
static void inner(struct json_object *obj) {
    verify_roots(obj, 0);
    security_state();
    close(MANIFEST_FD);
    if (aa_stack_profile(text(obj, "profile"))) fail("stack exact work profile");
    const char *stack = exact_stack(obj);
    security_state();
    close_extra(CONTROL_FD);
    admission(obj);
    close_extra(-1);
    const char *worker = text(obj, "worker"), *profile = stack;
    if (!strcmp(text(obj, "mode"), "exec")) {
        char *args[] = {"/usr/bin/python3", "-I", "-B", (char *)worker,
                       "--profile", (char *)profile, NULL};
        execv(args[0], args);
    } else {
        /* Fixed script, arguments bound as positional values; no interpolated code.
         * Keep interactive Bash job control instead of exec-replacing the shell.
         */
        char *args[] = {"/bin/bash", "--noprofile", "--norc", "-i", "-c",
            "/usr/bin/python3 -I -B \"$1\" --profile \"$2\"; code=$?; "
            "if [ \"$code\" -ne 0 ]; then exit \"$code\"; fi; "
            "printf 'DYNAMIC_SHELL_CONTINUED\\n'; exit 0",
            "morphz-fixed-probe", (char *)worker, (char *)profile, NULL};
        execv(args[0], args);
    }
    fail("fixed synthetic worker exec");
}
int main(int argc, char **argv) {
    int is_outer = argc == 3 && !strcmp(argv[1], "--outer");
    int is_inner = argc == 2 && !strcmp(argv[1], "--inner");
    if (!is_outer && !is_inner) fail("only fixed outer/path or inner/FD interface is supported");
    bootstrap_only();
    int fd = is_outer ? open(argv[2], O_RDONLY | O_NOFOLLOW | O_CLOEXEC) : MANIFEST_FD;
    struct json_object *obj = manifest_fd(fd, is_outer, is_outer ? argv[2] : NULL);
    char executable[PATH_MAX];
    ssize_t n = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
    if (n <= 0 || n >= (ssize_t)sizeof(executable) - 1) fail("entry executable");
    executable[n] = 0;
    if (strcmp(executable, text(obj, "entry"))) fail("unexpected executable identity");
    if (is_outer) outer(obj, fd);
    inner(obj);
    return 78;
}
