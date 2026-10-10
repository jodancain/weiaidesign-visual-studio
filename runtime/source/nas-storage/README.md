# NAS video storage

The existing multipart upload contract remains `/api/v1/videos/upload`, protected by `VIDEO_STORAGE_TOKEN`. Uploads with both `source_task_id` and `kind` reuse the latest existing record for that pair. Studio v3 uses the gateway job UUID and `kind=studio-v3-video`; the gateway persists the archive receipt separately from local video completion.

`store_upload` acquires a SQLite `BEGIN IMMEDIATE` writer lock before lookup, then keeps it through file creation and record insertion. Parallel retries therefore see the committed row before creating a second file. Normal write/insert failures roll back the row and remove only the current attempt's newly created file. Historical duplicate records and their media are preserved; the new lookup index is deliberately non-unique. This change does not delete existing data or claim recovery from an OS/power failure mid-write.

Local concurrency tests use a temporary database and fixture media, never production NAS data:

```sh
python3 nas-storage/test_atomic_upload.py
```

Coverage: eight simultaneous retries produce one record and one file; historical duplicates remain intact; a forced SQL insertion failure cleans up only its own new file; different `kind` values and requests without an idempotency pair retain their previous behavior. Deployment and a real NAS upload/readback remain separate checks.
