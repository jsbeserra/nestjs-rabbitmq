export function tryParseJson(content: string) {
  try {
    return !!content && JSON.parse(content);
  } catch (e) {
    return content;
  }
}

export function merge(obj1, obj2) {
  const merged = { ...obj1 };

  for (const key in obj2) {
    if (merged[key] === undefined || merged[key] === null)
      merged[key] = obj2[key];
  }
  return merged;
}
