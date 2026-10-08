import { isIP } from 'node:net';

/** The 8 hextets of a valid IPv6 address (zone id dropped, embedded IPv4 converted). */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase().split('%')[0] ?? '';
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    const high = ((a << 8) | b).toString(16);
    const low = ((c << 8) | d).toString(16);
    text = `${text.slice(0, dotted.index)}${high}:${low}`;
  }
  const [head = '', tail] = text.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups =
    tail === undefined
      ? headGroups
      : [
          ...headGroups,
          ...Array<string>(8 - headGroups.length - tailGroups.length).fill('0'),
          ...tailGroups,
        ];
  return groups.map((group) => Number.parseInt(group, 16));
}

/**
 * The key under which a client address is rate limited: an IPv4 address as
 * is (IPv4-mapped IPv6 included), and an IPv6 address by its /64 prefix,
 * since a single subscriber usually controls a whole /64.
 */
export function clientAddressKey(ip: string): string {
  const version = isIP(ip.split('%')[0] ?? '');
  if (version === 4) return ip;
  if (version !== 6) return ip.toLowerCase();
  const groups = ipv6Groups(ip);
  const isMapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (isMapped) {
    const high = groups[6] ?? 0;
    const low = groups[7] ?? 0;
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}
