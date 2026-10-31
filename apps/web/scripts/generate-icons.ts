import { fileURLToPath } from "node:url";
import sharp from "sharp";

const outputDirectory = fileURLToPath(new URL("../public/icons/", import.meta.url));

function iconSvg(size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#080b12"/><rect x="22" y="15" width="56" height="70" rx="8" fill="#131a2a" stroke="#5eead4" stroke-width="4"/><circle cx="50" cy="50" r="15" fill="none" stroke="#5eead4" stroke-width="5"/><path d="M35 50h30" stroke="#5eead4" stroke-width="5"/><circle cx="50" cy="50" r="4" fill="#f8fafc"/></svg>`;
}

async function generateIcons(): Promise<void> {
  await Promise.all(
    [192, 512].map((size) =>
      sharp(Buffer.from(iconSvg(size)))
        .png()
        .toFile(`${outputDirectory}icon-${size}.png`),
    ),
  );
}

generateIcons().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
