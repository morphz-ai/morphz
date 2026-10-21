#define _GNU_SOURCE
/* Fixed CI peers, not an installed command launcher. Distinct root-owned
 * Runtime and launcher binaries exercise the real service registration roles. */
#include "mounts.h"
#include <json-c/json.h>
#include <sys/apparmor.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
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
static struct json_object *exchange(const char *path, struct json_object *request, int *received) {
    int connection = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
    struct sockaddr_un address = {.sun_family = AF_UNIX};
    if (connection < 0 || strlen(path) >= sizeof(address.sun_path)) fail("control address");
    strcpy(address.sun_path, path);
    if (connect(connection, (struct sockaddr *)&address, sizeof(address))) fail("control connection");
    struct ucred server;
    socklen_t size = sizeof(server);
    if (getsockopt(connection, SOL_SOCKET, SO_PEERCRED, &server, &size) || server.uid != 0) fail("service identity");
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
    if (descriptor != -1 || !strcmp(argv[4], "rogue")) fail("registration authority");
    const char *launch = string(reply, "launch");
    printf("{\"registered\":\"%s\"}\n", launch);
    fflush(stdout);
    pid_t child = fork();
    if (child < 0) fail("launcher fork");
    if (!child) {
        execl(argv[3], argv[3], argv[1], launch, argv[4], argv[5], argv[6], argv[7], (char *)NULL);
        fail("fixed launcher exec");
    }
    int status;
    if (waitpid(child, &status, 0) != child || !WIFEXITED(status)) fail("launcher exit");
    return WEXITSTATUS(status);
}
#else
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
int main(int argc, char **argv) {
    if (argc != 7 || morphz_unprivileged()) fail("fixed launcher arguments");
    int descriptor;
    struct json_object *reply = exchange(argv[1], request("claim", argv[2]), &descriptor);
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
    const char *boot = string(reply, "bootstrap"), *work = string(reply, "work");
    if (aa_change_profile(boot) || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || aa_stack_profile(work))
        fail("fixed synthetic work entry");
    exact_label(boot, work);
    if (morphz_unprivileged() || morphz_close_extra_fds(-1)) fail("pre-work closure");
    pid_t background = fork();
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
        exact_label(boot, work);
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
