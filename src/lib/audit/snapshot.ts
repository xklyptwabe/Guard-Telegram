import type { SnapshotStatus } from './enums.js';

/**
 * A snapshot is either actually `observed` data, or one of the explicit
 * "no data" statuses. This is the type that makes criterion
 * "отсутствующий snapshot не заменяется пустым JSON" structurally true:
 * there is no `data` field to default to `{}` unless `status === 'observed'`.
 */
export type Snapshot<T> =
  | { readonly status: 'observed'; readonly data: T }
  | { readonly status: Exclude<SnapshotStatus, 'observed'> };

export function observed<T>(data: T): Snapshot<T> {
  return { status: 'observed', data };
}

export function notObserved<T>(): Snapshot<T> {
  return { status: 'not_observed' };
}

export function redacted<T>(): Snapshot<T> {
  return { status: 'redacted' };
}

export function unknownSnapshot<T>(): Snapshot<T> {
  return { status: 'unknown' };
}

export function notApplicable<T>(): Snapshot<T> {
  return { status: 'not_applicable' };
}

export function isObserved<T>(snapshot: Snapshot<T>): snapshot is { status: 'observed'; data: T } {
  return snapshot.status === 'observed';
}

/** Applies `fn` to the payload only when the snapshot actually carries data. */
export function mapSnapshot<T, R>(snapshot: Snapshot<T>, fn: (data: T) => R): Snapshot<R> {
  if (snapshot.status === 'observed') {
    return observed(fn(snapshot.data));
  }
  return snapshot;
}
