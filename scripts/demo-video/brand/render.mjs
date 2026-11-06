// Renders the title card (1920x1080) and the logo (1024x1024 PNG) in headless Chrome.
import { launch, sleep } from "../cdp.mjs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("./", import.meta.url));

const card = await launch({ width: 1920, height: 1080, scale: 1, port: 9381 });
await card.goto("file://" + here + "title.html", 3500);
await card.evaluate("document.getElementById('rec-cursor')?.remove(); document.getElementById('rec-ripple')?.remove()");
await sleep(300);
await card.shot(here + "title-card.png");
card.close();

const logo = await launch({ width: 1024, height: 1024, scale: 1, port: 9382 });
await logo.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } }); // transparent PNG
await logo.goto("file://" + here + "logo.html", 2000);
await logo.evaluate("document.getElementById('rec-cursor')?.remove(); document.getElementById('rec-ripple')?.remove()");
await sleep(300);
await logo.shot(here + "logo.png");
logo.close();
console.log("rendered title-card.png and logo.png");
