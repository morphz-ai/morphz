/* Diagnostic only: retain every real write and slow its return in the owned
 * peer-notification child, after Linux has already emitted the WAL hint. */
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

static unsigned delayed_writes;

static void delay_owned_wal(int descriptor, long long offset) {
    const char *database = getenv("MORPHZ_NOTIFICATION_TEST_DATABASE");
    if (database == NULL) return;
    char link[64], path[4096], expected[4096];
    int size = snprintf(link, sizeof(link), "/proc/self/fd/%d", descriptor);
    if (size < 0 || (size_t)size >= sizeof(link)) return;
    ssize_t length = readlink(link, path, sizeof(path) - 1);
    if (length < 0) return;
    path[length] = '\0';
    size = snprintf(expected, sizeof(expected), "%s-wal", database);
    if (size < 0 || (size_t)size >= sizeof(expected) || strcmp(path, expected) != 0)
        return;
    unsigned count = __atomic_add_fetch(&delayed_writes, 1, __ATOMIC_RELAXED);
    if (count == 1 || count % 16 == 0)
        dprintf(STDERR_FILENO, "owned WAL post-write delay #%u, offset=%lld\n", count, offset);
    struct timespec remaining = {.tv_sec = 0, .tv_nsec = 10000000};
    while (nanosleep(&remaining, &remaining) != 0 && errno == EINTR) {}
}

ssize_t pwrite(int descriptor, const void *buffer, size_t count, off_t offset) {
    ssize_t result = syscall(SYS_pwrite64, descriptor, buffer, count, offset);
    int saved_errno = errno;
    if (result > 0) delay_owned_wal(descriptor, (long long)offset);
    errno = saved_errno;
    return result;
}

ssize_t pwrite64(int descriptor, const void *buffer, size_t count, off64_t offset) {
    ssize_t result = syscall(SYS_pwrite64, descriptor, buffer, count, offset);
    int saved_errno = errno;
    if (result > 0) delay_owned_wal(descriptor, (long long)offset);
    errno = saved_errno;
    return result;
}
