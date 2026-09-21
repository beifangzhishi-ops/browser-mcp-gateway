export function toolCallFailed(payload) {
  if (payload?.result?.isError === true) return true;
  for (const item of payload?.result?.content || []) {
    if (item?.type !== 'text' || typeof item.text !== 'string') continue;
    let decoded;
    try {
      decoded = JSON.parse(item.text);
    } catch {
      continue;
    }
    if (decoded?.isError === true || decoded?.data?.isError === true) return true;
  }
  return false;
}
