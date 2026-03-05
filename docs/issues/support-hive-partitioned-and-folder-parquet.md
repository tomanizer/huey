# Support Hive-partitioned and folder Parquet for "Local file" and "Load from URL"

## Summary

Extend the **local file** and **load from URL** flows so users can load:

1. **Hive-partitioned Parquet datasets** – directory layout like `base/year=2020/month=01/file.parquet` where partition columns are inferred from path segments.
2. **Flat folder Parquet** – a directory (or URL prefix) where all `.parquet` files share the same schema and should be read as one table.

Today, only a **single file** or an **explicit multi-select list of files** is supported. There is no glob pattern, no directory/folder selection, and no `hive_partitioning` option.

---

## Current behavior (reference for implementer)

### Data source types

- **`FILE`** – Single file path or single URL. Stored as `fileName` (string).  
  SQL: `read_parquet('path')` or `read_csv('url')`.
- **`FILES`** – Explicit array of file paths. Stored as `fileNames` (array).  
  SQL: `read_parquet([path1, path2, ...], filename=true)`.

No glob patterns and no reader option `hive_partitioning` are passed.

### Where behavior is implemented

| Area | File(s) | What to touch |
|------|--------|----------------|
| Building the `read_parquet`/reader call | `src/DataSource/duckdb/DuckDbDataSource.js` | `#getDuckDbFileReaderCall(duckdb_reader, fileNames, settings)` – builds the SQL string. Today: string → single path; array → list of paths. Need to support a “path pattern” (glob) and pass `hive_partitioning` when applicable. |
| Parquet reader settings | `src/DatasourceSettingsDialog/DatasourceSettings.js` | `#template["parquetReader"]` – only `parquetReaderFilename` and `parquetReaderBinaryAsString`. Add options for e.g. `parquetReaderHivePartitioning` and (if desired) “read as folder/glob”. |
| Datasource creation (URL) | `src/DataSource/duckdb/DuckDbDataSource.js` | `static async createFromUrl(duckdb, instance, url)` – creates a `FILE` datasource with a single URL. For “folder URL” support, either create a new type (e.g. URL_FOLDER) or allow URL to be a prefix/pattern and set a flag so the reader uses glob + options. |
| Datasource creation (local) | `src/UploadUi/UploadUi.js` | `#uploadFile`, `uploadFiles` – handle FileList from `<input type="file">`. For folder: use `webkitdirectory` or `directory` and build a list of `.parquet` paths (or pass a glob-like descriptor). |
| UI for “Load from URL” | `src/UploadUi/UploadUi.js`, `src/DataSource/DataSourcesUi.js` | URL is a single string. For folder/prefix: allow user to enter a base URL and optionally check “Hive-partitioned” or “All Parquet in path”. |
| Datasource settings dialog | `src/DatasourceSettingsDialog/DatasourceSettingsDialog.js` | CSV has a “Detect settings” flow; Parquet has minimal options. Add Parquet options for hive partitioning and (if needed) filename column. |
| Serialization / state | `src/DataSource/duckdb/DuckDbDataSource.js` | `getState()`, `setState()` / config – ensure new fields (e.g. `isHivePartitioned`, `pathIsGlob`) are saved and restored so the same behavior applies after reload. |

### DuckDB API (for implementation)

- **Glob pattern:** `read_parquet('/path/to/*.parquet')` or `read_parquet('/path/to/**/*.parquet')` – DuckDB accepts globs in the path string.  
  Ref: [DuckDB – Reading Multiple Files](https://duckdb.org/docs/data/multiple_files/overview) (or current docs).
- **Hive partitioning:**  
  `read_parquet('path/to/*/*.parquet', hive_partitioning = true)`  
  Parses directory segments as `key=value` and exposes them as columns.  
  Ref: [DuckDB – Hive Partitioning](https://duckdb.org/docs/data/partitioning/hive_partitioning.html), and [PR #4097](https://github.com/duckdb/duckdb/pull/4097) (filename column + hive partitioning).
- **Same-schema folder (no Hive):**  
  `read_parquet('path/to/*.parquet')` or `read_parquet(['file1.parquet', 'file2.parquet'], filename=true)`.  
  No need for `hive_partitioning`; optional `filename=true` to add a source filename column.

### Browser vs Node / URL constraints

- **Local file:** In the browser, the app uses the File API; there is no real filesystem glob. So “folder” means: user selects a **directory** (via directory picker), app collects all `.parquet` files (and optionally detects `key=value` subpaths for Hive), then either passes the file list to DuckDB or registers them so that a glob-like pattern can be used if the runtime supports it.
- **Load from URL:** A single URL is passed to `createFromUrl`. For “folder” or “Hive”:
  - If the backend serves a directory listing, the client could fetch it and build a list of Parquet URLs, then use `read_parquet([url1, url2, ...], filename=true)` (and optionally `hive_partitioning` if the URLs encode partition info).
  - Alternatively, if the server supports it, the user could provide a “base URL” that the server expands to a list of Parquet URLs; the client would then need an API to resolve that base URL to a list and create a FILES-like datasource.
  - For a true “glob” over HTTP, DuckDB would need to support HTTP glob (if available in the build used by Huey). Document assumptions (e.g. “single URL only” vs “list of URLs”) in the issue/implementation.

---

## Desired behavior (for a coding agent)

### 1. Hive-partitioned Parquet

- **Local:** User selects a **directory** (or a root path) that contains Hive-style subdirs (e.g. `year=2020/month=01/file.parquet`). App either:
  - Enumerates all `.parquet` files under that directory and passes them to `read_parquet(..., hive_partitioning = true)`, or
  - Passes a glob pattern to DuckDB if the environment supports it (e.g. in Electron/Node), with `hive_partitioning = true`.
- **URL:** User provides a base URL; if the app can obtain a list of Parquet URLs (e.g. from a manifest or directory listing), use `read_parquet([...], hive_partitioning = true)` (or the appropriate option name in the DuckDB version in use). Partition columns should be inferred from path segments where possible.
- **Settings:** In datasource settings for Parquet, expose a **“Hive-partitioned”** (or “Parse Hive partitions”) option so that the same datasource can be toggled between “flat” and “Hive” when the layout matches.

### 2. Flat folder (same-schema Parquet)

- **Local:** User selects a **directory**; the app finds all `.parquet` files in that directory (and optionally one level of subdirs, or configurable depth) and loads them as one table. Use `read_parquet([...], filename=true)` or a single glob if supported (e.g. `read_parquet('dir/*.parquet')`).
- **URL:** Same idea: user provides a base URL; app gets a list of Parquet URLs (e.g. from a manifest or listing) and uses `read_parquet([url1, url2, ...], filename=true)`.
- No `hive_partitioning`; optionally expose “Add filename column” in Parquet reader settings (already partially present as `parquetReaderFilename`).

### 3. Backward compatibility

- Existing **single file** and **multi-select file list** behavior must remain unchanged.
- New behavior should be opt-in (e.g. “Open folder” vs “Open file”, or a checkbox “Treat as Hive-partitioned” / “Load all Parquet in path”).

---

## Implementation notes (for agent)

1. **`#getDuckDbFileReaderCall`**  
   - Today the first argument is either a quoted string (single path) or `[path1, path2, ...]` with `filename=true`.  
   - Extend so that when the datasource represents a “folder” or “pattern”, the first argument can be a glob string (e.g. `'https://example.com/data/*.parquet'`) or the existing array form.  
   - When Hive partitioning is enabled, append `, hive_partitioning = true` (or the exact option name for the DuckDB version in use) to the `read_parquet` call.  
   - Map `DatasourceSettings` parquet options (e.g. `parquetReaderHivePartitioning`) to these arguments in the same way CSV options are mapped in `DatasourceSettings.getReaderArguments` / `getReaderArgumentsSql`.

2. **Parquet reader template**  
   In `DatasourceSettings.js`, add to `parquetReader` template something like:
   - `parquetReaderHivePartitioning: false`
   and ensure `getReaderArguments('parquetReader')` includes it in the SQL when true. Use the same naming convention as existing options (e.g. `parquet_reader_hive_partitioning` or whatever DuckDB expects).

3. **Local folder selection**  
   - In the upload/select flow, add a way to “Select folder” (e.g. `<input type="file" webkitdirectory>` or similar).  
   - Filter to `.parquet` files, optionally sort by path.  
   - Create a datasource that stores either:
     - the list of files (current FILES behavior), or  
     - a “folder” indicator + list of paths, and in `#getDuckDbFileReaderCall` pass that list (and set `filename=true`, and `hive_partitioning` if the user chose Hive).  
   - If the path structure looks like `.../key=value/...`, consider auto-enabling or suggesting Hive partitioning in the UI.

4. **Load from URL for “folder”**  
   - Define what “folder URL” means (e.g. a URL that returns HTML directory listing, or a known manifest URL).  
   - Implement a small flow that fetches the listing/manifest, parses Parquet URLs, and creates a datasource with that list (and optional `hive_partitioning`).  
   - If DuckDB in the browser can open multiple HTTP URLs in one `read_parquet([...])`, use that; otherwise document the limitation.

5. **IDs and display names**  
   - For a “folder” datasource, define a stable ID and display name (e.g. folder name or base URL path) so it appears correctly in the datasource list and in saved state.

6. **Tests**  
   - Add or extend tests that mock a list of Parquet paths (and optionally a glob) and assert the generated SQL contains `read_parquet(...)` with the expected arguments (`hive_partitioning`, `filename`, etc.).  
   - If possible, add an integration test with a small Hive-partitioned dataset (e.g. two partitions, one file each) to ensure partition columns appear.

---

## Acceptance criteria

- [ ] User can select a **local directory** and load all Parquet files in it as one table (same schema), with optional “filename” column.
- [ ] User can select a **local directory** with Hive-style layout (`key=value` subdirs) and load as one table with partition columns inferred; “Hive partitioning” can be toggled in datasource settings.
- [ ] “Load from URL” supports either (a) a list of Parquet URLs, or (b) a base URL that is resolved to a list (with a documented mechanism), and the same “flat” vs “Hive” behavior as local where applicable.
- [ ] Parquet reader settings include a “Hive partitioning” option that is persisted and applied when building `read_parquet(...)`.
- [ ] Existing single-file and multi-select file datasources behave unchanged.
- [ ] Generated SQL is valid for the DuckDB version used by the project (verify `read_parquet` signature and option names in DuckDB docs or source).

---

## References

- DuckDB docs: [Reading Multiple Files](https://duckdb.org/docs/data/multiple_files/overview), [Hive Partitioning](https://duckdb.org/docs/data/partitioning/hive_partitioning.html) (check current URLs).
- DuckDB PR: [Filename column + hive partitioning parsing](https://github.com/duckdb/duckdb/pull/4097).
- Code: `src/DataSource/duckdb/DuckDbDataSource.js` (`#getDuckDbFileReaderCall`, `getRelationExpression`), `src/DatasourceSettingsDialog/DatasourceSettings.js` (parquet template and `getReaderArguments`), `src/UploadUi/UploadUi.js` (file/URL handling).
