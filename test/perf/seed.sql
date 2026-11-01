-- The 1M-row `perf_test.users` the 100k IN-list benchmark reads (test/perf/fixtures.ts).
-- user_id is yymmdd + a 9-digit sequence n (0..999999), the day 2024-01-01 + n % 730.
-- Load it into the test MySQL, about 5 s:
--
--   TABLE_CRAFT_DATABASES=mysql bun test/db/up.ts
--   docker compose -f test/db/compose.yml exec -T mysql mysql -uroot -ptable_craft < test/perf/seed.sql
CREATE DATABASE IF NOT EXISTS perf_test;
GRANT ALL PRIVILEGES ON perf_test.* TO 'table_craft'@'%';
USE perf_test;
DROP TABLE IF EXISTS users;
CREATE TABLE users (
  user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY COMMENT 'yymmdd + 9-digit sequence',
  username VARCHAR(64) NOT NULL,
  email VARCHAR(128) NOT NULL,
  phone CHAR(10) NOT NULL,
  status TINYINT NOT NULL,
  balance DECIMAL(18,2) NOT NULL,
  created_at DATETIME NOT NULL
) ENGINE=InnoDB;

DROP TABLE IF EXISTS digits;
CREATE TABLE digits (d TINYINT PRIMARY KEY);
INSERT INTO digits VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9);

INSERT INTO users (user_id, username, email, phone, status, balance, created_at)
SELECT
  CAST(CONCAT(DATE_FORMAT(day, '%y%m%d'), LPAD(n, 9, '0')) AS UNSIGNED),
  CONCAT('user_', n),
  CONCAT('user_', n, '@example.com'),
  CONCAT('09', LPAD(n * 7 % 100000000, 8, '0')),
  n % 4,
  ROUND((n * 9301 + 49297) % 233280 / 100, 2),
  day + INTERVAL (n % 86400) SECOND
FROM (
  SELECT n, DATE('2024-01-01') + INTERVAL (n % 730) DAY AS day
  FROM (
    SELECT a.d + b.d * 10 + c.d * 100 + e.d * 1000 + f.d * 10000 + g.d * 100000 AS n
    FROM digits a, digits b, digits c, digits e, digits f, digits g
  ) seq
) src;

DROP TABLE digits;
ANALYZE TABLE users;
SELECT COUNT(*), MIN(user_id), MAX(user_id) FROM users;
