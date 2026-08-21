#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <dirent.h>
#include <signal.h>
#include <sqlite3.h>
#include <stdint.h>
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

#define MAX_TRACKED_PROCESS_GROUPS 512

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

static ssize_t read_preserved_process_groups(
    const char *path,
    pid_t *groups,
    size_t capacity
) {
    sqlite3 *database = NULL;
    sqlite3_stmt *statement = NULL;
    size_t count = 0;
    const char *sql =
        "SELECT DISTINCT CAST(json_extract(child.request_json, '$.process_group_id') AS INTEGER) "
        "FROM execution_jobs child "
        "WHERE child.status IN ('queued','waiting_approval','running') "
        "  AND json_extract(child.request_json, '$.kind') = 'background_exec' "
        "  AND COALESCE(json_extract(child.request_json, '$.keep_running'), 0) = 1";
    if (sqlite3_open_v2(path, &database, SQLITE_OPEN_READONLY, NULL) != SQLITE_OK) {
        if (database != NULL) {
            sqlite3_close(database);
        }
        return -1;
    }
    sqlite3_busy_timeout(database, 2000);
    if (sqlite3_prepare_v2(database, sql, -1, &statement, NULL) != SQLITE_OK) {
        sqlite3_close(database);
        return -1;
    }
    int step_result = SQLITE_DONE;
    while ((step_result = sqlite3_step(statement)) == SQLITE_ROW) {
        sqlite3_int64 value = sqlite3_column_int64(statement, 0);
        if (value > 1 && value <= (sqlite3_int64)INT32_MAX) {
            if (count == capacity) {
                sqlite3_finalize(statement);
                sqlite3_close(database);
                return -1;
            }
            groups[count++] = (pid_t)value;
        }
    }
    if (step_result != SQLITE_DONE) {
        sqlite3_finalize(statement);
        sqlite3_close(database);
        return -1;
    }
    sqlite3_finalize(statement);
    sqlite3_close(database);
    return (ssize_t)count;
}

static int contains_process_group(const pid_t *groups, size_t count, pid_t group) {
    for (size_t index = 0; index < count; ++index) {
        if (groups[index] == group) {
            return 1;
        }
    }
    return 0;
}

static void append_child_processes(
    pid_t runtime_pid,
    pid_t *children,
    size_t *count,
    size_t capacity
) {
    char task_path[128];
    snprintf(task_path, sizeof(task_path), "/proc/%ld/task", (long)runtime_pid);
    DIR *tasks = opendir(task_path);
    if (tasks == NULL) {
        return;
    }
    struct dirent *entry = NULL;
    while ((entry = readdir(tasks)) != NULL && *count < capacity) {
        char *end = NULL;
        errno = 0;
        long thread_id = strtol(entry->d_name, &end, 10);
        if (errno != 0 || end == entry->d_name || *end != '\0' || thread_id <= 0) {
            continue;
        }
        char children_path[192];
        snprintf(
            children_path,
            sizeof(children_path),
            "/proc/%ld/task/%ld/children",
            (long)runtime_pid,
            thread_id
        );
        FILE *stream = fopen(children_path, "r");
        if (stream == NULL) {
            continue;
        }
        long child = 0;
        while (*count < capacity && fscanf(stream, "%ld", &child) == 1) {
            if (child <= 1 || child > INT32_MAX) {
                continue;
            }
            pid_t child_pid = (pid_t)child;
            int duplicate = 0;
            for (size_t index = 0; index < *count; ++index) {
                if (children[index] == child_pid) {
                    duplicate = 1;
                    break;
                }
            }
            if (!duplicate) {
                children[(*count)++] = child_pid;
            }
        }
        fclose(stream);
    }
    closedir(tasks);
}

static int quiesce_runtime(const char *database_path, pid_t runtime_pid) {
    if (runtime_pid <= 1 || runtime_pid == getpid()) {
        fprintf(stderr, "refusing to quiesce invalid Runtime pid %ld\n", (long)runtime_pid);
        return 2;
    }
    if (!process_alive(runtime_pid)) {
        return 0;
    }
    if (kill(runtime_pid, SIGSTOP) != 0 && errno != ESRCH) {
        perror("failed to freeze Morphz Runtime");
        return 3;
    }

    pid_t preserved[MAX_TRACKED_PROCESS_GROUPS];
    pid_t children[MAX_TRACKED_PROCESS_GROUPS];
    ssize_t preserved_result = read_preserved_process_groups(
        database_path,
        preserved,
        MAX_TRACKED_PROCESS_GROUPS
    );
    if (preserved_result < 0) {
        fprintf(
            stderr,
            "could not inspect persistent background services; terminating only the frozen Runtime\n"
        );
        kill(runtime_pid, SIGKILL);
        return 5;
    }
    size_t preserved_count = (size_t)preserved_result;
    size_t child_count = 0;
    append_child_processes(
        runtime_pid,
        children,
        &child_count,
        MAX_TRACKED_PROCESS_GROUPS
    );

    pid_t terminated[MAX_TRACKED_PROCESS_GROUPS];
    size_t terminated_count = 0;
    for (size_t index = 0; index < child_count; ++index) {
        pid_t group = getpgid(children[index]);
        if (group <= 1 || group == getpgrp()
            || contains_process_group(preserved, preserved_count, group)
            || contains_process_group(terminated, terminated_count, group)) {
            continue;
        }
        if (kill(-group, SIGTERM) == 0 || errno == EPERM) {
            terminated[terminated_count++] = group;
        }
    }

    struct timespec grace = {.tv_sec = 1, .tv_nsec = 0};
    nanosleep(&grace, NULL);
    for (size_t index = 0; index < terminated_count; ++index) {
        if (kill(-terminated[index], 0) == 0 || errno == EPERM) {
            kill(-terminated[index], SIGKILL);
        }
    }
    if (kill(runtime_pid, SIGKILL) != 0 && errno != ESRCH) {
        perror("failed to terminate Morphz Runtime");
        return 4;
    }
    fprintf(
        stderr,
        "quiesced Morphz Runtime pid=%ld; preserved=%zu persistent groups; terminated=%zu transient groups\n",
        (long)runtime_pid,
        preserved_count,
        terminated_count
    );
    return 0;
}

int main(int argc, char **argv) {
    if (argc == 4 && strcmp(argv[1], "--quiesce") == 0) {
        return quiesce_runtime(
            argv[2],
            (pid_t)positive_long(argv[3], "pid")
        );
    }
    if (argc < 4 || argc > 5) {
        fprintf(
            stderr,
            "usage: %s DB_PATH PID TIMEOUT_SECS [IDLE_GRACE_SECS]\n"
            "       %s --quiesce DB_PATH PID\n",
            argv[0],
            argv[0]
        );
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
