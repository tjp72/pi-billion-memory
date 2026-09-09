// Test-only entry point. The published extension entry is src/index.ts.
export { default } from "./extension.js";
import {
  MemoryDb,
  loadSqlite,
  scanSources,
  scanAll,
  scanCurrentSession,
  piSessionCwdMap,
  piSessionHeaderCwd,
  loadOpencodeSessionMap,
  listSourceFiles,
  loadSources,
  getDb,
  formatResults,
  redactSecrets,
  configureForTests,
  resetPiHeaderReadCount,
  getPiHeaderReadCount,
} from "./extension.js";

export const internals = {
  MemoryDb,
  loadSqlite,
  scanSources,
  scanAll,
  scanCurrentSession,
  piSessionCwdMap,
  piSessionHeaderCwd,
  loadOpencodeSessionMap,
  listSourceFiles,
  loadSources,
  getDb,
  formatResults,
  redactSecrets,
  _setConfig: configureForTests,
  _resetPiHeaderReadCount: resetPiHeaderReadCount,
  _piHeaderReadCount: getPiHeaderReadCount,
};
