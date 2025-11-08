import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue };

type Meta = {
    signature: string;
    createdAt: string;
};

function cacheDir() {
    return path.join(app.getPath('userData'), 'ddiTreeCache', 'v1');
}
function treePath() {
    return path.join(cacheDir(), 'tree.json');
}
function metaPath() {
    return path.join(cacheDir(), 'meta.json');
}

export function computeSignature(): string {
    const hash = crypto.createHash('sha256');
    try {
        hash.update(String(app.getVersion?.() ?? '0'));
    } catch {}

    // Use same paths as in main.ts for the R assets
    try {
        const meta = fs.readFileSync(path.join(__dirname, '../src/library/R/library.js.metadata'));
        hash.update(meta);
    } catch {}

    try {
        const data = fs.readFileSync(path.join(__dirname, '../src/library/R/library.data.gz'));
        hash.update(data);
    } catch {}

    return hash.digest('hex');
}

function loadFromCache(expectedSig: string): JsonValue | null {
    try {
        const metaRaw = fs.readFileSync(metaPath(), 'utf8');
        const meta = JSON.parse(metaRaw) as Meta;
        if (meta.signature !== expectedSig) return null;
        const raw = fs.readFileSync(treePath(), 'utf8');
        const parsed = JSON.parse(raw) as JsonValue;
        try { console.log(`[DDITreeCache] Loaded cached tree from: ${treePath()}`); } catch {}
        return parsed;
    } catch {
        return null;
    }
}

function saveToCache(sig: string, tree: JsonValue) {
    try {
        fs.mkdirSync(cacheDir(), { recursive: true });
        fs.writeFileSync(treePath(), JSON.stringify(tree), 'utf8');
        const meta: Meta = { signature: sig, createdAt: new Date().toISOString() };
        fs.writeFileSync(metaPath(), JSON.stringify(meta, null, 2), 'utf8');
        try {
            console.log(`[DDITreeCache] Saved tree to: ${treePath()}`);
            console.log(`[DDITreeCache] Wrote metadata to: ${metaPath()}`);
        } catch {}
    } catch {
        // best-effort: ignore write failures
    }
}

export async function getOrBuildDDITree(buildFn: () => Promise<JsonValue>): Promise<JsonValue> {
    const sig = computeSignature();
    const cached = loadFromCache(sig);
    if (cached) return cached;
    const fresh = await buildFn();
    saveToCache(sig, fresh);
    return fresh;
}
