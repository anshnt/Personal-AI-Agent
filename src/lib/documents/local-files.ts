import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { env } from '@/lib/env';

/**
 * Read files from a directory the operator explicitly opted into.
 *
 * Giving a model filesystem access is the highest-risk capability in this whole
 * application, so access is deny-by-default: without `AGENT_FILES_DIR` set,
 * nothing here can read anything. Every path is resolved through
 * `realpath` and re-checked against the root, which is what closes symlink
 * escapes — a `..` check on the raw string does not, because a symlink inside
 * the root can point anywhere.
 */

export class FileAccessError extends Error {}

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_LISTING_ENTRIES = 500;

/** Resolve the configured root, or undefined when the feature is switched off. */
export async function filesRoot(): Promise<string | undefined> {
  const configured = env.filesDir;
  if (!configured) return undefined;

  try {
    // The root itself is resolved through symlinks once, so every later
    // comparison is between two fully-resolved paths.
    return await realpath(resolve(configured));
  } catch {
    throw new FileAccessError(
      `AGENT_FILES_DIR is set to "${configured}", which does not exist or is not readable.`,
    );
  }
}

/**
 * Turn a user- or model-supplied path into a real path inside the root.
 *
 * Throws rather than returning a fallback: a path that cannot be proven to be
 * inside the root must not be read, and silently substituting a different file
 * would be worse than failing.
 */
export async function resolveInsideRoot(requested: string): Promise<{ root: string; path: string }> {
  const root = await filesRoot();
  if (!root) {
    throw new FileAccessError(
      'Local file access is disabled. Set AGENT_FILES_DIR to a directory to enable it.',
    );
  }

  const trimmed = requested.trim();
  if (trimmed.length === 0) {
    throw new FileAccessError('No path given.');
  }
  // A NUL byte truncates the path at the syscall boundary, so "safe.txt\0/etc/passwd"
  // could pass a string check and open something else entirely.
  if (trimmed.includes('\u0000')) {
    throw new FileAccessError('That path is not valid.');
  }

  // An absolute path is only honoured if it is already inside the root; a
  // relative one is resolved against it.
  const candidate = isAbsolute(trimmed) ? resolve(trimmed) : resolve(root, trimmed);

  // First check the lexical path. This catches `../` traversal before any
  // filesystem call, so a probe cannot be used to test for a file's existence
  // outside the root.
  if (!isWithin(root, candidate)) {
    throw new FileAccessError(`"${requested}" is outside the allowed directory.`);
  }

  // Then check the resolved path, which is what catches a symlink inside the
  // root pointing out of it. ENOENT is reported as not-found rather than as a
  // security failure, because the distinction is useful and not sensitive:
  // the lexical check above already established the path is in scope.
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new FileAccessError(`"${requested}" does not exist.`);
  }

  if (!isWithin(root, real)) {
    throw new FileAccessError(
      `"${requested}" resolves outside the allowed directory through a symlink.`,
    );
  }

  return { root, path: real };
}

/**
 * True when `candidate` is the root or sits underneath it.
 *
 * `relative()` is used rather than a `startsWith` on the string, which would
 * accept `/data-other` as being inside `/data`.
 */
export function isWithin(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

export interface LocalEntry {
  path: string;
  kind: 'file' | 'directory';
  sizeBytes?: number;
  modifiedAt?: string;
}

/** List the contents of a directory inside the root, as root-relative paths. */
export async function listLocalFiles(
  requestedPath: string,
  options: { recursive?: boolean } = {},
): Promise<LocalEntry[]> {
  const { root, path } = await resolveInsideRoot(requestedPath || '.');

  const info = await stat(path);
  if (!info.isDirectory()) {
    throw new FileAccessError(`"${requestedPath}" is a file, not a directory.`);
  }

  const entries: LocalEntry[] = [];
  const queue: string[] = [path];

  while (queue.length > 0 && entries.length < MAX_LISTING_ENTRIES) {
    const current = queue.shift();
    if (current === undefined) break;

    const children = await readdir(current, { withFileTypes: true });
    for (const child of children) {
      if (entries.length >= MAX_LISTING_ENTRIES) break;
      // Dotfiles are skipped: `.git`, `.env`, and friends are noise at best and
      // credentials at worst, and nobody asking to "list my notes" means them.
      if (child.name.startsWith('.')) continue;

      const childPath = join(current, child.name);
      const relativePath = relative(root, childPath) || '.';

      if (child.isDirectory()) {
        entries.push({ path: relativePath, kind: 'directory' });
        if (options.recursive) queue.push(childPath);
      } else if (child.isFile()) {
        const fileInfo = await stat(childPath).catch(() => undefined);
        entries.push({
          path: relativePath,
          kind: 'file',
          sizeBytes: fileInfo?.size,
          modifiedAt: fileInfo?.mtime.toISOString(),
        });
      }
      // Anything else — sockets, devices, dangling symlinks — is skipped.
    }
  }

  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export interface LocalFile {
  /** Path relative to the configured root. */
  path: string;
  bytes: Uint8Array;
  sizeBytes: number;
  modifiedAt: string;
}

export async function readLocalFile(requestedPath: string): Promise<LocalFile> {
  const { root, path } = await resolveInsideRoot(requestedPath);

  const info = await stat(path);
  if (!info.isFile()) {
    throw new FileAccessError(`"${requestedPath}" is not a regular file.`);
  }
  if (info.size > MAX_FILE_BYTES) {
    throw new FileAccessError(
      `"${requestedPath}" is ${formatBytes(info.size)}, over the ${formatBytes(MAX_FILE_BYTES)} limit.`,
    );
  }

  const buffer = await readFile(path);

  return {
    path: relative(root, path),
    bytes: new Uint8Array(buffer),
    sizeBytes: info.size,
    modifiedAt: info.mtime.toISOString(),
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Exposed for tests: the separator used when joining listing paths. */
export const pathSeparator = sep;
