import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API_BASE_URL = "https://api.curseforge.com";
const API_KEY = process.env.CURSEFORGE_API_TOKEN || process.env.CURSEFORGE_API_KEY;
const DISPLAY_TIME_ZONE = process.env.CURSEFORGE_DISPLAY_TIME_ZONE || "Europe/Stockholm";
const WOW_GAME_ID = 1;
const OUTPUT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../assets/data/addon-meta.json",
);

const RELEASE_TYPES = new Map([
  [1, "Release"],
  [2, "Beta"],
  [3, "Alpha"],
]);

// Add future CurseForge projects here. The key must match data-curseforge-addon in index.html.
const ADDONS = [
  {
    key: "oathbound",
    projectId: 1465925,
    pageUrl: "https://www.curseforge.com/wow/addons/oathbound",
    releaseType: 1,
  },
  {
    key: "addonsearch",
    pageUrl: "https://www.curseforge.com/wow/addons/addonsearch-addon-search",
    releaseType: 1,
  },
  {
    key: "hidechatbuttonreborn",
    pageUrl: "https://www.curseforge.com/wow/addons/hidechatbuttonreborn",
    releaseType: 1,
  },
];

const VERSION_FLAVOR_LABELS = [
  { prefix: "1.", label: "Classic" },
  { prefix: "2.", label: "TBC" },
  { prefix: "3.", label: "Wrath" },
  { prefix: "4.", label: "Cataclysm" },
  { prefix: "5.", label: "MoP Classic" },
  { pattern: /^(?:[6-9]|1\d)\./, label: "Retail" },
];

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: DISPLAY_TIME_ZONE,
});

const assertApiKey = () => {
  if (!API_KEY) {
    throw new Error(
      "Missing CURSEFORGE_API_TOKEN. Add it as a GitHub Actions secret before this workflow can refresh addon metadata.",
    );
  }
};

const getJson = async (path, params = {}) => {
  const url = new URL(path, API_BASE_URL);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  });

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "x-api-key": API_KEY,
    },
  });

  if (!response.ok) {
    throw new Error(`CurseForge request failed: ${response.status} ${response.statusText} for ${url.pathname}`);
  }

  return response.json();
};

const getSlugFromPageUrl = (pageUrl) => {
  const pathname = new URL(pageUrl).pathname;
  const slug = pathname.split("/").filter(Boolean).at(-1);

  if (!slug) {
    throw new Error(`Could not derive CurseForge slug from ${pageUrl}`);
  }

  return slug;
};

const getAddonProject = async (addon) => {
  const slug = addon.slug || getSlugFromPageUrl(addon.pageUrl);

  if (addon.projectId) {
    return {
      id: addon.projectId,
      slug,
      name: addon.key,
      links: {
        websiteUrl: addon.pageUrl,
      },
    };
  }

  const searchResponse = await getJson("/v1/mods/search", {
    gameId: addon.gameId || WOW_GAME_ID,
    slug,
    pageSize: 50,
  });
  const projects = searchResponse.data || [];
  const project = projects.find((candidate) => candidate.slug === slug);

  if (!project) {
    throw new Error(`CurseForge project not found for slug "${slug}".`);
  }

  return project;
};

const compareVersionParts = (left, right) => {
  const maxLength = Math.max(left.length, right.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = Number(left[index] || 0);
    const rightPart = Number(right[index] || 0);

    if (leftPart !== rightPart) {
      return leftPart - rightPart;
    }
  }

  return 0;
};

const compareGameVersions = (left, right) =>
  compareVersionParts(
    left.split("."),
    right.split("."),
  );

const isNumericGameVersion = (version) => /^\d+(?:\.\d+)+$/.test(version);

const unique = (values) => [...new Set(values.filter(Boolean))];

const getGameVersions = (file) => {
  const versions = unique([
    ...(file.gameVersions || []),
    ...(file.sortableGameVersions || []).flatMap((version) => [
      version.gameVersion,
      version.gameVersionName,
    ]),
  ].map((version) => String(version || "").trim()));
  const numericVersions = versions.filter(isNumericGameVersion).sort(compareGameVersions);

  return numericVersions.length > 0 ? numericVersions : versions;
};

const getGameVersionLabel = (version) => {
  const versionFlavor = VERSION_FLAVOR_LABELS.find(({ prefix, pattern }) =>
    prefix ? version.startsWith(prefix) : pattern.test(version),
  );

  return [versionFlavor?.label, version].filter(Boolean).join(" ");
};

const getLatestFile = (files, releaseType) => {
  const availableFiles = files
    .filter((file) => file.isAvailable !== false)
    .filter((file) => (releaseType ? file.releaseType === releaseType : true));

  if (availableFiles.length === 0) {
    throw new Error("CurseForge returned no available files matching the configured release type.");
  }

  return availableFiles.sort((left, right) => new Date(right.fileDate) - new Date(left.fileDate))[0];
};

const getVersionFromFile = (file) => {
  const label = file.displayName || file.fileName || "";
  const versionMatch = label.match(/(?:^|[-_\s])v?(\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)/);

  if (versionMatch) {
    return `v${versionMatch[1]}`;
  }

  return label.replace(/\.[^.]+$/, "");
};

const formatAddon = async (addon) => {
  const project = await getAddonProject(addon);
  const filesResponse = await getJson(`/v1/mods/${project.id}/files`, {
    pageSize: 50,
  });
  const latestFile = getLatestFile(filesResponse.data || [], addon.releaseType);
  const version = getVersionFromFile(latestFile);
  const gameVersions = getGameVersions(latestFile);
  const gameVersionLabels = gameVersions.map(getGameVersionLabel);
  const updatedAt = latestFile.fileDate;
  const latestVersionLabel = `Latest ${version}`;
  const updatedLabel = `Updated ${dateFormatter.format(new Date(updatedAt))}`;

  return [
    addon.key,
    {
      projectId: project.id,
      slug: project.slug,
      pageUrl: addon.pageUrl || project.links?.websiteUrl,
      fileId: latestFile.id,
      fileName: latestFile.fileName,
      releaseType: RELEASE_TYPES.get(latestFile.releaseType) || String(latestFile.releaseType),
      latestVersion: version,
      latestVersionLabel,
      gameVersion: gameVersions[0] || "",
      gameVersions,
      gameVersionLabel: gameVersionLabels[0] || "",
      gameVersionLabels,
      updatedAt,
      updatedLabel,
      factLabels: [
        latestVersionLabel,
        ...gameVersionLabels,
        updatedLabel,
      ].filter(Boolean),
    },
  ];
};

const main = async () => {
  assertApiKey();

  const addonEntries = await Promise.all(ADDONS.map(formatAddon));
  const metadata = {
    generatedAt: new Date().toISOString(),
    source: "CurseForge Core API",
    addons: Object.fromEntries(addonEntries),
  };

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(metadata, null, 2)}\n`);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
