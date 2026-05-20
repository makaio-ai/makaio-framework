const port = process.env.__INSPECTOR_GATE_PORT;
const file = process.env.__INSPECTOR_GATE_FILE ?? '';
if (port) {
  const url = `http://localhost:${port}/ready?f=${encodeURIComponent(file)}`;
  for (let i = 0; i < 100; i++) {
    const r = await fetch(url).catch(() => null);
    if (r?.ok) break;
    await Bun.sleep(10);
  }

  const { beforeAll } = await import('bun:test');
  beforeAll(async () => {
    await Bun.sleep(1000);
  });
}
