let duckdbModule = null;
let database = null;
let connection = null;
let reservedWords = [];

export function setDatabase(duckdb, db, conn) {
  duckdbModule = duckdb;
  database = db;
  connection = conn;
}

export function getDuckDbModule() {
  return duckdbModule;
}

export function getDatabase() {
  return database;
}

export function getConnection() {
  return connection;
}

export function setReservedWords(words) {
  reservedWords = Array.isArray(words) ? words : [];
}

export function getReservedWords() {
  return reservedWords;
}
