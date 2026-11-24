/** Whether a request URL belongs to the staff API (/admin/*), which has its own sessions. */
export function isStaffPath(url: string): boolean {
  return url === '/admin' || url.startsWith('/admin/') || url.startsWith('/admin?');
}

/** Whether a request URL belongs to the shop app's API (/shop/*), which has its own sessions. */
export function isShopPath(url: string): boolean {
  return url === '/shop' || url.startsWith('/shop/') || url.startsWith('/shop?');
}
