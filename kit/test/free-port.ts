import net from 'node:net';

/**
 * A port for a test's page that nothing listens on now. The fixture's own port, 17979, is the same in every checkout,
 * so two test runs at once (a vouch beside a PR's test, or another session's check) met there and one failed with
 * EADDRINUSE. This one is picked at random from 40000-48999, below Windows' dynamic ports (49152 on), which it hands to
 * listen(0) and to outgoing connections and reserves ranges of for Hyper-V and WSL (EACCES), and is checked free on
 * 127.0.0.1 and ::1, where the kit's server listens.
 */
export async function freePort(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const port = 40000 + Math.floor(Math.random() * 9000);
    if ((await canListen(port, '127.0.0.1')) && (await canListen(port, '::1'))) return port;
  }
  throw new Error('no free port in 40000-48999 after 50 tries');
}

/** Whether a listen on `host`:`port` works now. A PC without IPv6 can't listen on ::1 at all, and that's fine. */
function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (e: NodeJS.ErrnoException) => resolve(host === '::1' && e.code !== 'EADDRINUSE' && e.code !== 'EACCES'));
    s.listen({ port, host, ipv6Only: host === '::1' }, () => s.close(() => resolve(true)));
  });
}
