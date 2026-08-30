import { createHash } from "node:crypto";
import {
    cp,
    mkdir,
    readFile,
    readdir,
    rename,
    rm,
    stat,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const vendorDirectory = path.join(repositoryRoot, "vendor");
const stageDirectory = path.join(repositoryRoot, ".vendor-stage");
const nextVendorDirectory = path.join(stageDirectory, "next");
const previousVendorDirectory = path.join(stageDirectory, "previous");

const packages = [
    {
        name: "opencc-wasm",
        directory: path.join("node_modules", "opencc-wasm"),
        destination: "opencc-wasm",
        assets: [
            ["dist/esm", "esm"],
            ["dist/data", "data"],
            ["LICENSE", "LICENSE"],
            ["NOTICE", "NOTICE"],
        ],
    },
    {
        name: "@zip.js/zip.js",
        directory: path.join("node_modules", "@zip.js", "zip.js"),
        destination: "zip.js",
        assets: [
            ["dist/zip-core-external.min.js", "zip-core-external.min.js"],
            ["dist/zip-web-worker.js", "zip-web-worker.js"],
            ["dist/zip-module.wasm", "zip-module.wasm"],
            ["LICENSE", "LICENSE"],
        ],
    },
    {
        name: "tocas",
        directory: path.join("node_modules", "tocas"),
        destination: "tocas",
        assets: [
            ["dist/tocas.min.css", "tocas.min.css"],
            ["dist/tocas.min.js", "tocas.min.js"],
            ["dist/fonts/icons", "fonts/icons"],
            ["dist/flags/4x3/tw.svg", "flags/4x3/tw.svg"],
            ["dist/flags/4x3/hk.svg", "flags/4x3/hk.svg"],
            ["LICENSE", "LICENSE"],
        ],
    },
    {
        name: "vue",
        directory: path.join("node_modules", "vue"),
        destination: "vue",
        assets: [
            ["dist/vue.global.prod.js", "vue.global.prod.js"],
            ["LICENSE", "LICENSE"],
        ],
    },
];

const argumentsSet = new Set(process.argv.slice(2));
const supportedArguments = new Set(["--check"]);
const unknownArguments = [...argumentsSet].filter((argument) => !supportedArguments.has(argument));

if (unknownArguments.length) {
    throw new Error(`Unknown argument: ${unknownArguments.join(", ")}`);
}

const checkOnly = argumentsSet.has("--check");

function assertManagedPath(target, expectedName) {
    if (path.dirname(target) !== repositoryRoot || path.basename(target) !== expectedName) {
        throw new Error(`Refusing to manage unexpected path: ${target}`);
    }
}

async function pathExists(target) {
    try {
        await stat(target);
        return true;
    } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
    }
}

async function loadJson(target) {
    return JSON.parse(await readFile(target, "utf8"));
}

async function validatePackages() {
    const projectPackage = await loadJson(path.join(repositoryRoot, "package.json"));

    for (const packageDefinition of packages) {
        const expectedVersion = projectPackage.devDependencies?.[packageDefinition.name];
        const packageRoot = path.join(repositoryRoot, packageDefinition.directory);
        const packageManifest = path.join(packageRoot, "package.json");

        if (!(await pathExists(packageManifest))) {
            throw new Error(`${packageDefinition.name} is not installed. Run npm ci first.`);
        }

        const installedPackage = await loadJson(packageManifest);
        if (installedPackage.version !== expectedVersion) {
            throw new Error(
                `${packageDefinition.name} ${installedPackage.version} is installed, but package.json pins ${expectedVersion}. Run npm ci.`,
            );
        }
    }
}

async function stageVendorTree() {
    await rm(stageDirectory, { recursive: true, force: true });
    await mkdir(nextVendorDirectory, { recursive: true });

    for (const packageDefinition of packages) {
        const packageRoot = path.join(repositoryRoot, packageDefinition.directory);
        const destinationRoot = path.join(nextVendorDirectory, packageDefinition.destination);

        for (const [sourceRelative, destinationRelative] of packageDefinition.assets) {
            const source = path.join(packageRoot, ...sourceRelative.split("/"));
            const destination = path.join(destinationRoot, ...destinationRelative.split("/"));
            if (!(await pathExists(source))) {
                throw new Error(`${packageDefinition.name} is missing expected asset: ${sourceRelative}`);
            }
            await mkdir(path.dirname(destination), { recursive: true });
            await cp(source, destination, { recursive: true, force: true });
        }
    }
}

async function hashFile(target) {
    return createHash("sha256").update(await readFile(target)).digest("hex");
}

async function describeTree(root) {
    const files = new Map();
    if (!(await pathExists(root))) return files;

    async function walk(directory) {
        const entries = await readdir(directory, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));

        for (const entry of entries) {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                await walk(absolute);
            } else if (entry.isFile()) {
                const relative = path.relative(root, absolute).split(path.sep).join("/");
                files.set(relative, await hashFile(absolute));
            } else {
                throw new Error(`Unsupported vendor entry: ${absolute}`);
            }
        }
    }

    await walk(root);
    return files;
}

async function compareVendorTrees() {
    const [expected, actual] = await Promise.all([
        describeTree(nextVendorDirectory),
        describeTree(vendorDirectory),
    ]);
    const differences = [];

    for (const [relative, digest] of expected) {
        if (!actual.has(relative)) differences.push(`missing: ${relative}`);
        else if (actual.get(relative) !== digest) differences.push(`changed: ${relative}`);
    }
    for (const relative of actual.keys()) {
        if (!expected.has(relative)) differences.push(`unexpected: ${relative}`);
    }

    return differences;
}

async function replaceVendorTree() {
    const hadPreviousVendor = await pathExists(vendorDirectory);
    if (hadPreviousVendor) await rename(vendorDirectory, previousVendorDirectory);

    try {
        await rename(nextVendorDirectory, vendorDirectory);
    } catch (error) {
        if (hadPreviousVendor && !(await pathExists(vendorDirectory))) {
            await rename(previousVendorDirectory, vendorDirectory);
        }
        throw error;
    }
}

assertManagedPath(vendorDirectory, "vendor");
assertManagedPath(stageDirectory, ".vendor-stage");

try {
    await validatePackages();
    await stageVendorTree();
    const differences = await compareVendorTrees();

    if (checkOnly) {
        if (differences.length) {
            const preview = differences.slice(0, 20).map((difference) => `  - ${difference}`).join("\n");
            const remainder = differences.length > 20 ? `\n  - …and ${differences.length - 20} more` : "";
            throw new Error(`vendor/ is out of date:\n${preview}${remainder}\nRun npm run vendor:update.`);
        }
        console.log("vendor/ matches the pinned npm packages.");
    } else if (!differences.length) {
        console.log("vendor/ is already up to date.");
    } else {
        await replaceVendorTree();
        console.log(`Updated vendor/ (${differences.length} file difference${differences.length === 1 ? "" : "s"}).`);
    }
} finally {
    await rm(stageDirectory, { recursive: true, force: true });
}
