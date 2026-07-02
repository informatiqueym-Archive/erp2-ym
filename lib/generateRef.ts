export function generateRef(prefix: string): string {
  const now = new Date();
  const year  = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day   = String(now.getDate()).padStart(2, '0');
  const hour  = String(now.getHours()).padStart(2, '0');
  const min   = String(now.getMinutes()).padStart(2, '0');
  const sec   = String(now.getSeconds()).padStart(2, '0');
  return `${prefix}-${year}${month}${day}-${hour}${min}${sec}`;
}
