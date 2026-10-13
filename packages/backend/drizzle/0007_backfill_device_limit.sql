-- Found the real root cause: when the device_limit column was first
-- added (migration 0003), its default was 2 at that moment - Postgres
-- backfills ADD COLUMN ... DEFAULT onto existing rows using the default
-- AT THAT TIME, not whatever the default is later changed to. Migration
-- 0004 (default -> 10) and 0006 (default -> 7, with an UPDATE for rows
-- still at 10) both only affected the column's default for *future*
-- inserts or rows at 10 - neither ever touched a row still sitting at
-- the original backfilled value of 2, which is exactly what this
-- account has been stuck at the whole time.
UPDATE "users" SET "device_limit" = 7 WHERE "device_limit" = 2;
