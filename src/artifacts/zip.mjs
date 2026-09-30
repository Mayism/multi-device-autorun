import { runPythonWorker } from "../runtime/python-worker.mjs";

/** Create a ZIP archive from directory or file sources, excluding transient artifacts. */
export async function createZip(sources, { excludeAbsPaths } = {}) {
  return runPythonWorker("zip", {
    sources,
    excludeAbsPaths: excludeAbsPaths instanceof Set ? [...excludeAbsPaths] : [],
  });
}
