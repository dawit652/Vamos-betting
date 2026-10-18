/** Whether a request URL belongs to the staff API (/admin/*), which has its own sessions. */
export function isStaffPath(url: string): boolean {
  return url === '/admin' || url.startsWith('/admin/') || url.startsWith('/admin?');
}
