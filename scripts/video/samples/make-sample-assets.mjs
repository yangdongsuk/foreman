// Regenerates samples/policy-card.png (a non-16:9 image to exercise the "image" segment's fit logic).
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser } from '../lib/chrome.mjs';
import { fileUrl } from '../lib/util.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const browser = await Browser.launch();
try {
  const page = await browser.newPage({ width: 1400, height: 900 });
  await page.goto(fileUrl(join(dir, 'policy-card.html')));
  writeFileSync(join(dir, 'policy-card.png'), await page.screenshot());
  console.log('wrote samples/policy-card.png');
} finally {
  await browser.close();
}
