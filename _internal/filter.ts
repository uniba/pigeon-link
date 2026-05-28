// Keys of a message that can be used as filter conditions.
// Adding a key here automatically expands the dispatched event combinations.
export const RECEIVE_FILTERABLE_KEYS = ["type"] as const;
export const SEND_FILTERABLE_KEYS = ["type"] as const;

export const normalizeFilter = (filter: Record<string, string>): string => {
  const sorted: Record<string, string> = {};
  Object.keys(filter).sort().forEach((k) => {
    sorted[k] = filter[k];
  });
  return JSON.stringify(sorted);
};

export const generateSubsets = <T>(items: readonly T[]): T[][] => {
  const result: T[][] = [];
  for (let i = 0; i < (1 << items.length); i++) {
    const subset: T[] = [];
    items.forEach((item, idx) => {
      if (i & (1 << idx)) subset.push(item);
    });
    result.push(subset);
  }
  return result;
};
