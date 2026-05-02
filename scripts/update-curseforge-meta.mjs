import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API_BASE_URL = "https://api.curseforge.com";
const API_KEY = process.env.CURSEFORGE_API_TOKEN || process.env.CURSEFORGE_API_KEY;
const DISPLAY_TIME_ZONE = process.env.CURSEFORGE_DISPLAY_TIME_ZONE || "Europe/Stockholm";
const OUTPUT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../assets/data/addon-meta.json",
);

const RELEASE_TYPES = new Map([
  [1, "Release"],
  [2, "Beta"],
  [3, "Alpha"],
]);

const ADDONS = [
  {
    key: "oathbound",
    projectId: 1465925,
    pageUrl: "https://www.curseforge.com/wow/addons/oathbound",
    gameFlavor: "Classic",
    releaseType: 1,
  },
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

const getHighestGameVersion = (versions = []) => {
  const numericVersions = versions
    .filter((version) => /^\d+(?:\.\d+)+$/.test(version))
    .sort((left, right) =>
      compareVersionParts(
        left.split("."),
        right.split("."),
      ),
    );

  return numericVersions.at(-1) || versions[0] || "";
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
  const filesResponse = await getJson(`/v1/mods/${addon.projectId}/files`, {
    pageSize: 50,
  });
  const latestFile = getLatestFile(filesResponse.data || [], addon.releaseType);
  const version = getVersionFromFile(latestFile);
  const gameVersion = getHighestGameVersion(latestFile.gameVersions);
  const updatedAt = latestFile.fileDate;

  return [
    addon.key,
    {
      projectId: addon.projectId,
      pageUrl: addon.pageUrl,
      fileId: latestFile.id,
      fileName: latestFile.fileName,
      releaseType: RELEASE_TYPES.get(latestFile.releaseType) || String(latestFile.releaseType),
      latestVersion: version,
      latestVersionLabel: `Latest ${version}`,
      gameVersion,
      gameVersionLabel: [addon.gameFlavor, gameVersion].filter(Boolean).join(" "),
      updatedAt,
      updatedLabel: `Updated ${dateFormatter.format(new Date(updatedAt))}`,
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
