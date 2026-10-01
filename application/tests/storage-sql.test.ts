import test from "node:test";
import assert from "node:assert/strict";
import { postgresSql } from "../packages/storage/src/sql.js";

test("PostgreSQL 参数转换只替换真正的占位符", () => {
  assert.equal(
    postgresSql(
      `SELECT '?' AS literal, "?" AS identifier, $tag$?$tag$ AS body, ? AS first
       -- ? is a comment
       /* ? is another comment */ WHERE name='it''s ?' AND id=?`,
      2,
    ),
    `SELECT '?' AS literal, "?" AS identifier, $tag$?$tag$ AS body, $1 AS first
       -- ? is a comment
       /* ? is another comment */ WHERE name='it''s ?' AND id=$2`,
  );
  assert.throws(() => postgresSql("SELECT ?", 0), /参数数量/);
  assert.throws(() => postgresSql("SELECT 'unfinished", 0), /未闭合/);
  assert.throws(() => postgresSql("SELECT /* unfinished", 0), /未闭合/);
});
