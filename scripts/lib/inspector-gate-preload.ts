const port = process.env.__INSPECTOR_GATE_PORT;
if (port) {
  const url = `http://localhost:${port}/ready`;
  const r = await fetch(url).catch(() => null);
  if (!r?.ok) {
    for (let i = 0; i < 50; i++) {
      await Bun.sleep(20);
      const r2 = await fetch(url).catch(() => null);
      if (r2?.ok) break;
    }
  }
}
