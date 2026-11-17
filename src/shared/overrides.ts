/** How many settings a site's entry sets itself; a field that is missing or `undefined` follows general. */
export function overrideCount(entry: object | undefined): number {
  return Object.values(entry ?? {}).filter((value) => value !== undefined).length;
}

/** `base` with every field the site sets itself laid over it: what the site actually gets. */
export function withOverrides<T extends object>(base: T, own: Partial<T> | undefined): T {
  const result = { ...base };
  for (const key of Object.keys(own ?? {}) as (keyof T)[]) {
    const value = own?.[key];
    if (value !== undefined) result[key] = value as T[keyof T];
  }
  return result;
}

/** `entry` without these fields, which then follow general again. */
export function withoutFields<T extends object>(entry: T, fields: (keyof T)[]): T {
  const kept = Object.entries(entry).filter(([key]) => !fields.includes(key as keyof T));
  return Object.fromEntries(kept) as T;
}
