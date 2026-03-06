# Export: Parquet, SQLite, and DuckDB formats

## Summary

Extend export so users can export query/pivot results to:

1. **Parquet** – Ensure Parquet export is available and clearly offered in all export entry points (in-app export dialog and, where applicable, server export API). Optionally align options (compression, row group size) between client and server.
2. **SQLite** – New format: export result to a `.sqlite` database file containing a single table with the result set.
3. **DuckDB** – New format: export result to a `.duckdb` database file containing a single table with the result set.

---

## Current state (reference for implementer)

### In-app export (browser)

- **File:** `src/ExportUi/ExportDialog.js`
- **Flow:** User picks export type → settings (e.g. delimiter, compression) → SQL is built → `getCopyToStatement(sql, tmpFileName, copyStatementOptions)` → DuckDB `COPY (SELECT ...) TO 'file' WITH (FORMAT ..., ...)` → file is read back and downloaded (or copied to clipboard).
- **Formats already implemented in the dialog:**
  - **Delimited (CSV/TSV):** `exportDelimited` – `FORMAT CSV`, delimiter/quote/header/compression. Fallback: if `COPY TO` fails (e.g. browser), run query and format as CSV in JS (`formatQueryResultAsCsv`).
  - **JSON:** `exportJson` – `FORMAT JSON`, compression, date/timestamp format.
  - **Parquet:** `exportParquet` – `FORMAT PARQUET`, compression (UNCOMPRESSED/SNAPPY/GZIP/ZSTD), `PARQUET_VERSION`, `ROW_GROUP_SIZE`, optional `COMPRESSION_LEVEL` for ZSTD.
  - **XLSX:** `exportXlsx` – `FORMAT 'xlsx'`, header, sheet name, row limit (requires Excel extension).
  - **SQL:** `exportSql` – exports the **query text** only (no COPY), not the result data.

- **Copy statement helper:** `src/util/sql/SQLHelper.js` – `getCopyToStatement(selectStatement, fileName, options)` builds `COPY (selectStatement) TO 'fileName' WITH (options)`.
- **Export menu / defaults:** `src/DataSource/DataSourcesUi.js` (e.g. `#getDownloadMenuHTML`) decides which export types to show per file type. `src/SettingsDialog/SettingsDialog.js` holds default export settings (e.g. `exportParquet: false` in template; toggles for which formats are enabled).
- **UI:** Export type tabs/radios in `src/index.html` (e.g. `exportDelimited`, `exportParquet`, `exportJson`, `exportXlsx`, `exportSql`). No tab for SQLite or DuckDB today.

### Server export API

- **File:** `server/export_service.py` – `ExportService.process()` runs `COPY (sql) TO path` with DuckDB.
- **Format:** `server/models.py` – `ExportFormat = Literal["parquet", "csv"]`; only `parquet` and `csv` are accepted. `body.query.format` drives file extension and COPY options.
- **Logic:** `fmt = body.query.format.lower()`; `file_ext = "parquet" if fmt == "parquet" else "csv"`; COPY uses `FORMAT PARQUET` or `FORMAT CSV, HEADER TRUE`. No SQLite or DuckDB format.
- **Router:** `server/routers/export.py` – sets `Content-Disposition` and media type from file suffix (`.parquet` vs default CSV).

So: **Parquet** is already supported in both app and server. **SQLite** and **DuckDB** are new formats for both.

---

## Desired behavior

### 1. Parquet

- **In-app:** Parquet is already implemented; ensure it is visible and selectable in the export dialog for all datasources where export is available (e.g. same list as CSV/TSV/XLSX/JSON). If any export entry point (e.g. context menu “Export”) omits Parquet, add it.
- **Server:** Already supports `format: "parquet"`. Optionally extend the API to accept optional Parquet options (e.g. compression) in the request body and pass them to `COPY (... ) TO ... (FORMAT PARQUET, ...)` so client and server behavior align.
- **Documentation:** If there is user-facing or API docs, mention Parquet alongside CSV/TSV/XLSX/JSON.

### 2. SQLite export

- **In-app:** Add an export type (e.g. `exportSqlite`) that produces a `.sqlite` file containing one table (e.g. `export_result` or a user-chosen name) with the same columns and rows as the query result.
- **Server (optional):** If the export API should support SQLite, add `format: "sqlite"` (or similar), and in `ExportService.process()` produce a `.sqlite` file (e.g. create temp DB, run `CREATE TABLE t AS SELECT ...`, move file to output path).
- **Implementation approach (browser):** DuckDB has no `COPY TO ... FORMAT SQLITE`. Options:
  - **A)** Use the DuckDB `sqlite` extension: attach a new in-memory or temp SQLite DB, create table from the query result (e.g. run query in DuckDB, then for each row INSERT into the attached SQLite DB), then read the SQLite file from the virtual filesystem and download. This may require creating the SQLite file via DuckDB’s `sqlite_attach` / write path if supported.
  - **B)** Run the query in DuckDB, fetch the result set in the client, then use a JS library (e.g. sql.js) to create a new SQLite DB in memory, create table from result schema, insert rows, and export the blob as a `.sqlite` file. This avoids relying on DuckDB to write SQLite.
- **Settings:** Optional: table name (default e.g. `export_result`), and whether to include a “filename” or “source” column if the result came from multiple sources.

### 3. DuckDB export

- **In-app:** Add an export type (e.g. `exportDuckdb`) that produces a `.duckdb` file containing one table with the same columns and rows as the query result.
- **Server (optional):** Add `format: "duckdb"` and in `ExportService.process()` create a new DuckDB file (e.g. `path.duckdb`), run `CREATE TABLE t AS (SELECT ...)` with the export SQL, then leave the file at the output path for download.
- **Implementation approach (browser):** DuckDB can attach a second database and run `CREATE TABLE db.schema.t AS (SELECT ...)`. So: create a temporary/virtual DuckDB file (e.g. in the browser’s virtual FS), `ATTACH 'path' AS export_db`, `CREATE TABLE export_db.main.result AS (SELECT ...)`, then read the file content and download. Need to confirm how the DuckDB-WASM build exposes creating and reading back a second database file; if not possible, fallback could be “run query, stream result, build a minimal .duckdb using a JS library” (if one exists) or document “DuckDB export available only via server API” for the browser build.
- **Settings:** Optional: table name (default e.g. `result` or `export_result`).

---

## Implementation notes (for agent)

### In-app export dialog

1. **New export types**
   - In `src/index.html`, add a radio + panel for SQLite (e.g. `exportSqlite`) and one for DuckDB (e.g. `exportDuckdb`), with minimal options (e.g. table name, optional compression for DuckDB if applicable).
   - In `src/ExportUi/ExportDialog.js`, in the big `switch (exportType)` that sets `fileExtension`, `copyStatementOptions`, and `data`:
     - For `exportSqlite`: no COPY; run query, then build SQLite file (see approaches above) and set `data` to the blob/bytes and `fileExtension = 'sqlite'`.
     - For `exportDuckdb`: either use COPY to an attached DB then read back, or run query and write a .duckdb (if supported); set `fileExtension = 'duckdb'`.
   - In `src/SettingsDialog/SettingsDialog.js`, add default keys for the new types (e.g. `exportSqlite`, `exportDuckdb`, and any options like table name).
   - In `src/DataSource/DataSourcesUi.js`, in the logic that builds the export menu (e.g. `#getDownloadMenuHTML` or equivalent), include the new formats in the list of export types offered for the relevant datasources (e.g. same as Parquet/CSV).

2. **Parquet**
   - Audit all places that list export formats (dialog, context menu, settings) and ensure `exportParquet` is included wherever CSV/TSV/XLSX/JSON are. No change to the existing Parquet COPY logic unless adding server-style options.

3. **MIME types / download**
   - Use appropriate MIME types for `.sqlite` and `.duckdb` (e.g. `application/vnd.sqlite3` and `application/vnd.duckdb` or `application/octet-stream`) and ensure `ExportUi.downloadBlob` (or equivalent) is called with the correct filename and type.

### Server export API

1. **Models**
   - In `server/models.py`, extend `ExportFormat` to include `"sqlite"` and `"duckdb"` (e.g. `Literal["parquet", "csv", "sqlite", "duckdb"]`).

2. **Export service**
   - In `server/export_service.py`, in `process()`:
     - For `fmt == "sqlite"`: create a temporary SQLite database file, execute the export SQL via DuckDB (e.g. attach the SQLite DB and run `INSERT INTO sqlite_main.export_result SELECT * FROM (...)` or use DuckDB’s ability to export to SQLite if available), or run the query in DuckDB and insert rows into a SQLite DB using Python’s `sqlite3`. Then move the file to `output_dir / f"{job_id}.sqlite"`.
     - For `fmt == "duckdb"`: create a new DuckDB file at `output_dir / f"{job_id}.duckdb"`, open it, run `CREATE TABLE export_result AS (SELECT ...)` with the parameterized export SQL (or equivalent), then close. Ensure the SQL is executed with the same parameters as the main export (e.g. date range, filters).
   - Set `file_path` and `file_ext` accordingly; in the router, add handling for `.sqlite` and `.duckdb` in `Content-Disposition` and media type.

3. **Validation**
   - Export API already validates `format`; ensure the new values are accepted and tested (e.g. in `server/tests/test_export_api.py` or similar).

### Tests

- **Client:** If there are unit tests for the export dialog, add cases that select SQLite and DuckDB and assert the correct file extension and that a download is triggered (or that the correct path is used). Mock the query result and, for SQLite, the SQLite-building path.
- **Server:** Add tests that submit an export with `format: "sqlite"` and `format: "duckdb"`, poll until complete, download the file, and assert the file exists and (e.g. for DuckDB) contains a table with expected row count or schema; for SQLite, open with `sqlite3` and run a simple `SELECT count(*)`.

---

## Acceptance criteria

- [ ] Parquet export is available and visible in all in-app export entry points where other data formats (CSV, XLSX, JSON) are offered.
- [ ] Server export API continues to support `format: "parquet"`; optionally supports extra Parquet options.
- [ ] User can export from the app to a **SQLite** file (`.sqlite`) containing one table with the query result; file downloads correctly.
- [ ] User can export from the app to a **DuckDB** file (`.duckdb`) containing one table with the query result; file downloads correctly (or behavior is documented if only supported via server in browser).
- [ ] Server export API accepts `format: "sqlite"` and `format: "duckdb"` and returns a downloadable `.sqlite` / `.duckdb` file with the result table.
- [ ] New formats are persisted in export settings (e.g. default table name) where applicable.
- [ ] Tests added/updated for new formats (client and server as applicable).

---

## References

- **Client:** `src/ExportUi/ExportDialog.js` (export type switch, COPY flow, fallback CSV), `src/util/sql/SQLHelper.js` (`getCopyToStatement`), `src/DataSource/DataSourcesUi.js` (export menu), `src/SettingsDialog/SettingsDialog.js` (export defaults), `src/index.html` (export dialog markup).
- **Server:** `server/export_service.py`, `server/models.py` (`ExportFormat`), `server/routers/export.py`.
- **DuckDB:** COPY statement supports FORMAT PARQUET, CSV, JSON, etc. No built-in FORMAT SQLITE or FORMAT DUCKDB; use ATTACH + CREATE TABLE ... AS or external tooling.
