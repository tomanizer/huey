import { getDuckDbLogLevel, initApplication } from './App/App.js';
import { showErrorDialog } from './ErrorDialog/ErrorDialog.js';
import { setDatabase } from './DataSource/duckdb/database.js';
import { duckDbLibraryUrl, tablerIconsFontUrl } from './version.js';

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
  const message = event.reason?.message ?? String(event.reason);
  showErrorDialog({ title: 'Unexpected error', description: message });
  event.preventDefault();
});

// Preload the tabler icons font
const preloadLink = document.createElement('link');
preloadLink.setAttribute('rel', 'preload');
preloadLink.setAttribute('as', 'font');
preloadLink.setAttribute('href', tablerIconsFontUrl);
preloadLink.setAttribute('crossorigin', 'true');
document.head.appendChild(preloadLink);

// Insert the @font-face rule for tabler icons
try {
  document.styleSheets[0]?.insertRule(`
    @font-face {
      font-family: "tabler-icons";
      font-style: normal;
      font-weight: 400;
      font-display: block;
      src: url("${tablerIconsFontUrl}") format("woff2");
    }
  `);
} catch (error) {
  console.warn('Unable to register tabler-icons font-face rule.', error);
}

try {
  const duckdb = await import(/* @vite-ignore */ duckDbLibraryUrl);
  const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);

  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
  );
  const worker = new Worker(workerUrl);
  const loglevel = getDuckDbLogLevel(duckdb);
  console.log(
    `Creating DuckDb Console Logger with level ${loglevel} (${duckdb.getLogLevelLabel(loglevel)}).`
  );
  const logger = new duckdb.ConsoleLogger(loglevel);

  const db = new duckdb.AsyncDuckDB(logger, worker);
  URL.revokeObjectURL(workerUrl);

  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  const connection = await db.connect();

  setDatabase(duckdb, db, connection);

  await initApplication();
} catch (error) {
  console.warn('DuckDB startup failed; continuing with remote-only application initialization.', error);
  try {
    await initApplication();
  } catch (initError) {
    document.body.setAttribute('aria-busy', false);
    console.error(initError);
    try {
      showErrorDialog({
        title: 'Application startup failed',
        description: initError?.message || String(initError)
      });
    } catch (dialogError) {
      console.error('Failed to show startup error dialog.', dialogError);
    }
  }
} finally {
  document.body.setAttribute('aria-busy', false);
}
