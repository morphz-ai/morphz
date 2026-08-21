#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <signal.h>
#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

typedef struct {
    int total_objectives;
    int active_objectives;
    int replies;
    int active_activations;
} RuntimeState;

static double monotonic_seconds(void) {
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) {
        return 0.0;
    }
    return (double)value.tv_sec + ((double)value.tv_nsec / 1000000000.0);
}

static int process_alive(pid_t pid) {
    if (kill(pid, 0) == 0) {
        return 1;
    }
    return errno == EPERM;
}

static int scalar(sqlite3 *database, const char *sql) {
    sqlite3_stmt *statement = NULL;
    int value = 0;
    if (sqlite3_prepare_v2(database, sql, -1, &statement, NULL) != SQLITE_OK) {
        return 0;
    }
    if (sqlite3_step(statement) == SQLITE_ROW) {
        value = sqlite3_column_int(statement, 0);
    }
    sqlite3_finalize(statement);
    return value;
}

static RuntimeState read_state(const char *path) {
    RuntimeState state = {0, 0, 0, 0};
    sqlite3 *database = NULL;
    if (access(path, F_OK) != 0) {
        return state;
    }
    if (sqlite3_open_v2(path, &database, SQLITE_OPEN_READONLY, NULL) != SQLITE_OK) {
        if (database != NULL) {
            sqlite3_close(database);
        }
        return state;
    }
    sqlite3_busy_timeout(database, 2000);
    state.total_objectives = scalar(database, "SELECT count(*) FROM objectives");
    state.active_objectives = scalar(
        database,
        "SELECT count(*) FROM objectives "
        "WHERE status NOT IN ('completed','cancelled','failed')"
    );
    state.replies = scalar(
        database,
        "SELECT count(*) FROM events WHERE topic='chat/reply'"
    );
    state.active_activations = scalar(
        database,
        "SELECT count(*) FROM thread_activations "
        "WHERE status IN ('queued','running')"
    );
    sqlite3_close(database);
    return state;
}

static int state_equal(RuntimeState left, RuntimeState right) {
    return left.total_objectives == right.total_objectives
        && left.active_objectives == right.active_objectives
        && left.replies == right.replies
        && left.active_activations == right.active_activations;
}

static long positive_long(const char *raw, const char *name) {
    char *end = NULL;
    errno = 0;
    long value = strtol(raw, &end, 10);
    if (errno != 0 || end == raw || *end != '\0' || value < 0) {
        fprintf(stderr, "invalid %s: %s\n", name, raw);
        exit(2);
    }
    return value;
}

int main(int argc, char **argv) {
    if (argc < 4 || argc > 5) {
        fprintf(stderr, "usage: %s DB_PATH PID TIMEOUT_SECS [IDLE_GRACE_SECS]\n", argv[0]);
        return 2;
    }
    const char *database_path = argv[1];
    pid_t pid = (pid_t)positive_long(argv[2], "pid");
    long timeout = positive_long(argv[3], "timeout");
    long idle_grace = argc == 5 ? positive_long(argv[4], "idle grace") : 20;
    double started = monotonic_seconds();
    double last_change = started;
    RuntimeState previous = {-1, -1, -1, -1};

    while (process_alive(pid)) {
        double now = monotonic_seconds();
        RuntimeState current = read_state(database_path);
        if (!state_equal(current, previous)) {
            previous = current;
            last_change = now;
        }
        if (current.replies > 0 && current.active_activations == 0
            && (current.total_objectives == 0 || current.active_objectives == 0)
            && now - last_change >= (double)idle_grace) {
            return 0;
        }
        if (now - started >= (double)timeout) {
            fprintf(stderr, "Morphz Harbor run exceeded timeout\n");
            return 124;
        }
        sleep(1);
    }
    fprintf(stderr, "Morphz exited before a stable terminal reply\n");
    return 3;
}
