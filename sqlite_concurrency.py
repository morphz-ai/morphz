import sqlite3
import threading
import time

DB_FILE = "example.db"

# 初始化数据库
def init_db():
    conn = sqlite3.connect(DB_FILE)
    conn.execute("PRAGMA journal_mode=WAL;")  # 1. 开启 WAL 模式
    conn.execute("CREATE TABLE IF NOT EXISTS test (id INTEGER PRIMARY KEY, val TEXT);")
    conn.close()

# 线程任务
def write_task(thread_id):
    # 2. 设置 timeout 防止立即报错
    conn = sqlite3.connect(DB_FILE, timeout=5.0)
    try:
        # 3. 使用 IMMEDIATE 显式声明写事务，防止死锁
        conn.execute("BEGIN IMMEDIATE;")
        conn.execute("INSERT INTO test (val) VALUES (?);", (f"Thread-{thread_id}",))
        time.sleep(0.5)  # 模拟耗时写入
        conn.commit()
        print(f"线程 {thread_id} 写入成功")
    except sqlite3.OperationalError as e:
        print(f"线程 {thread_id} 失败: {e}")
    finally:
        conn.close()

if __name__ == "__main__":
    init_db()
    threads = []
    for i in range(5):
        t = threading.Thread(target=write_task, args=(i,))
        threads.append(t)
        t.start()
        
    for t in threads:
        t.join()
