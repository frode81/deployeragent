import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";

const DYNAMIC_DIR = process.env.TRAEFIK_DYNAMIC_DIR ?? "/dynamic";

/** Kommaseparerte origins (f.eks. dashboard-URL) som kan embedde apper i iframe. */
function dashboardFrameAncestorsCsp(): string | null {
  const raw = (process.env.DASHBOARD_FRAME_ANCESTORS ?? "").trim();
  if (!raw) return null;
  const origins = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (origins.length === 0) return null;
  return `frame-ancestors 'self' ${origins.join(" ")}`;
}

export function writeTraefikConfig(opts: {
  slug: string;
  domain: string;
  containerName: string;
  port: number;
}): void {
  mkdirSync(DYNAMIC_DIR, { recursive: true });

  const embedCsp = dashboardFrameAncestorsCsp();
  const middlewareName = `${opts.slug}-embed`;

  const lines: string[] = [
    "http:",
    "  routers:",
    `    ${opts.slug}:`,
    `      rule: "Host(\`${opts.domain}\`)"`,
    "      entryPoints:",
    "        - websecure",
    `      service: ${opts.slug}`,
  ];

  if (embedCsp) {
    lines.push("      middlewares:", `        - ${middlewareName}`);
  }

  lines.push("      tls:", "        certResolver: letsencrypt");

  if (embedCsp) {
    lines.push(
      "  middlewares:",
      `    ${middlewareName}:`,
      "      headers:",
      "        frameDeny: false",
      `        contentSecurityPolicy: "${embedCsp}"`,
    );
  }

  lines.push(
    "  services:",
    `    ${opts.slug}:`,
    "      loadBalancer:",
    "        servers:",
    `          - url: "http://${opts.containerName}:${opts.port}"`,
    "",
  );

  writeFileSync(join(DYNAMIC_DIR, `${opts.slug}.yml`), lines.join("\n"), "utf8");
}

export function removeTraefikConfig(slug: string): void {
  try {
    unlinkSync(join(DYNAMIC_DIR, `${slug}.yml`));
  } catch {
    // Ignore if file not found
  }
}
