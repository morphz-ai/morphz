#define _GNU_SOURCE
/* Fixed isolated test entry, not the production launcher or an installed API. */
#include <sys/apparmor.h>
#include <sys/prctl.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void fail(const char *reason) {
    fprintf(stderr, "fixed kernel entry refused: %s (errno=%d)\n", reason, errno);
    exit(78);
}

static void current_label(char *out, size_t length) {
    FILE *stream = fopen("/proc/self/attr/current", "r");
    if (!stream || !fgets(out, (int)length, stream)) fail("read label");
    fclose(stream);
    out[strcspn(out, "\n")] = 0;
}

int main(int argc, char **argv) {
    if (argc != 4 || getuid() == 0 || geteuid() != getuid()) fail("fixed non-root arguments");
    char actual[512], expected[512];
    if (snprintf(expected, sizeof(expected), "%s (enforce)", argv[1]) >= (int)sizeof(expected))
        fail("label length");
    current_label(actual, sizeof(actual));
    if (strcmp(actual, expected)) fail("not the exact bootstrap");
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) fail("NoNewPrivs");
    if (aa_stack_profile(argv[2])) fail("aa_stack_profile");
    current_label(actual, sizeof(actual));
    if (snprintf(expected, sizeof(expected), "%s//&%s (enforce)", argv[1], argv[2]) >= (int)sizeof(expected))
        fail("stack length");
    if (strcmp(actual, expected)) {
        if (snprintf(expected, sizeof(expected), "%s//&%s (enforce)", argv[2], argv[1]) >= (int)sizeof(expected)
                || strcmp(actual, expected)) fail("not the exact retained enforcing stack");
    }
    execl("/usr/bin/python3", "/usr/bin/python3", "-I", "-B", argv[3], "--worker",
          "--bootstrap", argv[1], "--work", argv[2], "--already-stacked", (char *)NULL);
    fail("fixed worker exec");
}
