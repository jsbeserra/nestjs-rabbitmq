export function tryParseJson(content: string) {
  try {
    return !!content && JSON.parse(content);
  } catch (e) {
    return content;
  }
}
