/**
 * @file writeFileAtomic.ts
 * @description Write-then-rename, so a reader (or a crash) never sees a
 *              half-written file. Shared by the JSON store and the
 *              Prometheus textfile exporter.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  // Unique per write, so concurrent writers never share a temp file.
  const tmp = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, data, 'utf-8');
    await fs.promises.rename(tmp, filePath);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
}
